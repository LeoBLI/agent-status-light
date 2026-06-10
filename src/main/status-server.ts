import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import {
  AgentState,
  AppConfig,
  Diagnostics,
  ProjectStatus,
  SessionStatus,
  STATE_PRIORITY,
  StatusTree,
  StatusUpdateInput,
  VALID_SOURCES,
  VALID_STATES,
  emptyCounts
} from "../shared/types";

interface StatusEvents {
  status: [StatusTree, SessionStatus, SessionStatus | undefined];
}

interface StatusStoreOptions {
  staleTimeoutMs?: number;
  doneToIdleMs?: number;
  titleOverridesPath?: string;
}

interface SessionTimers {
  stale?: NodeJS.Timeout;
}

export class StatusStore extends EventEmitter {
  private readonly sessions = new Map<string, SessionStatus>();
  private readonly timers = new Map<string, SessionTimers>();
  private readonly events: SessionStatus[] = [];
  private readonly createdAt = Date.now();
  private readonly staleTimeoutMs: number;
  private readonly titleOverridesPath: string | undefined;
  private readonly titleOverrides = new Map<string, string>();

  constructor(options: StatusStoreOptions = {}) {
    super();
    this.staleTimeoutMs = options.staleTimeoutMs ?? 10 * 60 * 1000;
    this.titleOverridesPath = options.titleOverridesPath;
    this.loadTitleOverrides();
  }

  override on<K extends keyof StatusEvents>(
    eventName: K,
    listener: (...args: StatusEvents[K]) => void
  ): this {
    return super.on(eventName, listener);
  }

  getStatus(): StatusTree["overall"] {
    return this.getStatuses(false).overall;
  }

  getStatuses(includeHidden = false): StatusTree {
    const projectsById = new Map<string, SessionStatus[]>();

    for (const session of this.sessions.values()) {
      if (!includeHidden && session.visibility === "dismissed") {
        continue;
      }

      const projectSessions = projectsById.get(session.projectId) ?? [];
      projectSessions.push({ ...session });
      projectsById.set(session.projectId, projectSessions);
    }

    const projects: ProjectStatus[] = Array.from(projectsById.entries()).map(
      ([projectId, projectSessions]) => {
        const sortedSessions = projectSessions.sort(compareStateThenUpdatedAt);
        const representative = sortedSessions[0];
        const counts = countStates(sortedSessions);

        return {
          projectId,
          projectName: representative.projectName,
          projectPath: representative.projectPath,
          state: highestState(sortedSessions.map((session) => session.state)),
          updatedAt: Math.max(...sortedSessions.map((session) => session.updatedAt)),
          sessions: sortedSessions,
          counts
        };
      }
    );

    projects.sort(compareProjectStateThenUpdatedAt);

    const allSessions = Array.from(this.sessions.values()).filter(
      (session) => includeHidden || session.visibility !== "dismissed"
    );
    const overallCounts = countStates(allSessions);

    return {
      overall: {
        state: highestState(projects.map((project) => project.state)),
        updatedAt:
          allSessions.length > 0
            ? Math.max(...allSessions.map((session) => session.updatedAt))
            : this.createdAt,
        counts: overallCounts,
        projectCount: projects.length,
        sessionCount: allSessions.length,
        waitingApprovalCount: overallCounts.waiting_approval,
        runningCount: overallCounts.running,
        errorCount: overallCounts.error,
        staleCount: overallCounts.stale
      },
      projects
    };
  }

  getSessions(): SessionStatus[] {
    return Array.from(this.sessions.values()).map((session) => ({ ...session }));
  }

  getEvents(): SessionStatus[] {
    return this.events.map((event) => ({ ...event }));
  }

  getDiagnostics(): Diagnostics {
    const hookEvents = this.events.filter((event) => event.source === "codex-hook");
    const lastHookEvent = hookEvents.at(-1);
    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;

    return {
      ok: true,
      statusVersion: "v3-hierarchical",
      currentStatus: this.getStatus(),
      hookHealth: {
        lastHookEventAt: lastHookEvent?.updatedAt,
        lastHookState: lastHookEvent?.state,
        isHookRecentlyActive: Boolean(
          lastHookEvent && now - lastHookEvent.updatedAt <= tenMinutesMs
        )
      },
      eventsCount: this.events.length,
      autoTransitions: {
        doneDisplayMs: 0,
        staleTimeoutMs: this.staleTimeoutMs
      }
    };
  }

  update(input: StatusUpdateInput): {
    session: SessionStatus;
    project: ProjectStatus | undefined;
    overall: StatusTree["overall"];
  } {
    const session = this.normalizeInput(input);
    const previous = this.sessions.get(session.id);
    const next = this.mergeSession(session, previous);

    this.applySession(next, previous);
    this.dismissLegacyDefaultSessions(next);
    this.scheduleAutomaticTransitions(next);

    const tree = this.getStatuses();
    return {
      session: next,
      project: tree.projects.find((project) => project.projectId === next.projectId),
      overall: tree.overall
    };
  }

  deleteSession(id: string): { deletedCount: number; deletedSessionIds: string[]; tree: StatusTree } {
    const existed = this.sessions.has(id);
    this.clearTimers(id);
    this.sessions.delete(id);
    return {
      deletedCount: existed ? 1 : 0,
      deletedSessionIds: existed ? [id] : [],
      tree: this.getStatuses()
    };
  }

  deleteProject(projectId: string): {
    deletedCount: number;
    deletedSessionIds: string[];
    tree: StatusTree;
  } {
    const deletedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        this.clearTimers(session.id);
        this.sessions.delete(session.id);
        deletedSessionIds.push(session.id);
      }
    }

    return {
      deletedCount: deletedSessionIds.length,
      deletedSessionIds,
      tree: this.getStatuses()
    };
  }

  dismissSession(id: string): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    const session = this.sessions.get(id);
    if (!session) {
      return { ok: true, dismissedCount: 0, dismissedSessionIds: [], tree: this.getStatuses() };
    }

    const previous = { ...session };
    const next = {
      ...session,
      visibility: "dismissed" as const,
      dismissedAt: Date.now(),
      updatedAt: Date.now()
    };

    this.applySession(next, previous);
    return { ok: true, dismissedCount: 1, dismissedSessionIds: [id], tree: this.getStatuses() };
  }

  updateSessionTitle(id: string, title: string): {
    ok: true;
    updatedCount: number;
    session?: SessionStatus;
    tree: StatusTree;
  } {
    this.titleOverrides.set(id, title);
    this.saveTitleOverrides();

    const session = this.sessions.get(id);
    if (!session) {
      return { ok: true, updatedCount: 0, tree: this.getStatuses() };
    }

    const previous = { ...session };
    const next = removeUndefined({
      ...session,
      title,
      sessionName: title,
      displayTitle: title,
      updatedAt: Date.now()
    });

    this.applySession(next, previous);
    this.scheduleAutomaticTransitions(next);
    return { ok: true, updatedCount: 1, session: next, tree: this.getStatuses() };
  }

  dismissProject(projectId: string): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    const dismissedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.visibility !== "dismissed") {
        const previous = { ...session };
        const next = {
          ...session,
          visibility: "dismissed" as const,
          dismissedAt: Date.now(),
          updatedAt: Date.now()
        };
        this.applySession(next, previous);
        dismissedSessionIds.push(session.id);
      }
    }

    return {
      ok: true,
      dismissedCount: dismissedSessionIds.length,
      dismissedSessionIds,
      tree: this.getStatuses()
    };
  }

  clearDone(): { ok: true; dismissedCount: number; dismissedSessionIds: string[]; tree: StatusTree } {
    const dismissedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.state === "done" && session.visibility !== "dismissed") {
        const previous = { ...session };
        const next = {
          ...session,
          visibility: "dismissed" as const,
          dismissedAt: Date.now(),
          updatedAt: Date.now()
        };
        this.applySession(next, previous);
        dismissedSessionIds.push(session.id);
      }
    }

    return {
      ok: true,
      dismissedCount: dismissedSessionIds.length,
      dismissedSessionIds,
      tree: this.getStatuses()
    };
  }

  private normalizeInput(input: StatusUpdateInput): SessionStatus {
    if (!input.state || !VALID_STATES.includes(input.state)) {
      throw new Error(`Invalid state. Expected one of: ${VALID_STATES.join(", ")}`);
    }

    const raw = asRecord(input.raw);
    const projectPath = text(input.projectPath) || text(raw?.cwd);
    const projectValue = text(input.project);
    const projectId =
      text(input.projectId) || projectPath || projectValue || text(raw?.cwd) || "unknown-project";
    const projectName =
      text(input.projectName) ||
      displayNameFromProject(projectValue) ||
      displayNameFromProject(projectPath) ||
      projectValue ||
      "Unknown Project";
    const sessionId =
      text(input.sessionId) ||
      text(input.taskId) ||
      text(raw?.session_id) ||
      text(raw?.sessionId) ||
      text(raw?.thread_id) ||
      text(raw?.threadId) ||
      text(raw?.conversation_id) ||
      text(raw?.conversationId) ||
      `${projectId}::default-session`;
    const id = `${projectId}::${sessionId}`;
    const title = text(input.title) || text(raw?.title) || this.titleOverrides.get(id);
    const sessionName = text(input.sessionName) || title || undefined;
    const source =
      input.source && VALID_SOURCES.includes(input.source) ? input.source : "manual";
    const now = Date.now();

    return {
      id,
      agent: text(input.agent) || "codex",
      projectId,
      projectName,
      projectPath,
      sessionId,
      sessionName,
      title,
      firstUserPromptSummary: text(input.firstUserPromptSummary),
      commandSummary: text(input.commandSummary),
      state: input.state,
      source,
      message: text(input.message) || defaultMessage(input.state),
      updatedAt: now,
      createdAt: now,
      visibility: "visible",
      raw: input.raw
    };
  }

  private mergeSession(next: SessionStatus, previous: SessionStatus | undefined): SessionStatus {
    const merged: SessionStatus = {
      ...previous,
      ...next,
      createdAt: previous?.createdAt ?? next.createdAt,
      projectName: next.projectName || previous?.projectName || "Unknown Project",
      projectPath: next.projectPath ?? previous?.projectPath,
      sessionName: next.sessionName ?? previous?.sessionName,
      title: next.title ?? previous?.title,
      firstUserPromptSummary: next.firstUserPromptSummary ?? previous?.firstUserPromptSummary,
      commandSummary: next.commandSummary ?? previous?.commandSummary,
      visibility: previous?.visibility ?? next.visibility ?? "visible",
      dismissedAt: previous?.dismissedAt,
      lastCompletedAt: previous?.lastCompletedAt,
      lastApprovalAt: previous?.lastApprovalAt
    };

    if (shouldRedisplay(next, previous)) {
      merged.visibility = "visible";
      delete merged.dismissedAt;
    }

    if (next.state === "done") {
      merged.lastCompletedAt = next.updatedAt;
    }

    if (next.state === "waiting_approval") {
      merged.lastApprovalAt = next.updatedAt;
    }

    merged.displayTitle = makeDisplayTitle(merged);
    return removeUndefined(merged);
  }

  private applySession(next: SessionStatus, previous: SessionStatus | undefined): void {
    this.clearTimers(next.id);
    this.sessions.set(next.id, next);
    this.events.push({ ...next });

    if (this.events.length > 500) {
      this.events.splice(0, this.events.length - 500);
    }

    this.emit("status", this.getStatuses(), { ...next }, previous ? { ...previous } : undefined);
  }

  private dismissLegacyDefaultSessions(next: SessionStatus): void {
    if (!next.projectPath || isDefaultSessionId(next.sessionId)) {
      return;
    }

    for (const session of this.sessions.values()) {
      if (
        session.id !== next.id &&
        session.source === "codex-hook" &&
        session.projectName === next.projectName &&
        !session.projectPath &&
        isDefaultSessionId(session.sessionId) &&
        session.visibility !== "dismissed"
      ) {
        const previous = { ...session };
        const dismissed = {
          ...session,
          visibility: "dismissed" as const,
          dismissedAt: next.updatedAt,
          updatedAt: next.updatedAt
        };
        this.applySession(dismissed, previous);
      }
    }
  }

  private scheduleAutomaticTransitions(session: SessionStatus): void {
    if (session.state === "running") {
      this.setTimer(session.id, "stale", () => {
        const current = this.sessions.get(session.id);
        if (current?.state === "running" && current.updatedAt === session.updatedAt) {
          this.update({
            agent: current.agent,
            projectId: current.projectId,
            projectName: current.projectName,
            projectPath: current.projectPath,
            sessionId: current.sessionId,
            sessionName: current.sessionName,
            title: current.title,
            state: "stale",
            source: "system",
            message: "No status update received recently",
            raw: current.raw
          });
        }
      }, this.staleTimeoutMs);
    }
  }

  private setTimer(id: string, key: keyof SessionTimers, callback: () => void, delayMs: number): void {
    const timers = this.timers.get(id) ?? {};
    timers[key] = setTimeout(callback, delayMs);
    this.timers.set(id, timers);
  }

  private clearTimers(id: string): void {
    const timers = this.timers.get(id);
    if (!timers) {
      return;
    }

    if (timers.stale) {
      clearTimeout(timers.stale);
    }

    this.timers.delete(id);
  }

  private loadTitleOverrides(): void {
    if (!this.titleOverridesPath || !existsSync(this.titleOverridesPath)) {
      return;
    }

    try {
      const data = JSON.parse(readFileSync(this.titleOverridesPath, "utf8")) as unknown;
      const records = asRecord(data);
      for (const [id, title] of Object.entries(records ?? {})) {
        const cleanTitle = text(title);
        if (cleanTitle) {
          this.titleOverrides.set(id, cleanTitle);
        }
      }
    } catch (error) {
      console.warn("Failed to load session title overrides:", error);
    }
  }

  private saveTitleOverrides(): void {
    if (!this.titleOverridesPath) {
      return;
    }

    try {
      mkdirSync(path.dirname(this.titleOverridesPath), { recursive: true });
      writeFileSync(
        this.titleOverridesPath,
        `${JSON.stringify(Object.fromEntries(this.titleOverrides), null, 2)}\n`,
        "utf8"
      );
    } catch (error) {
      console.warn("Failed to save session title overrides:", error);
    }
  }
}

export function startStatusServer(config: AppConfig, store: StatusStore): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, store);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      sendJson(response, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      console.log(`Agent Status Light listening at http://localhost:${config.port}`);
      resolve(server);
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: StatusStore
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");

  if (request.method === "OPTIONS") {
    applyCors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname === "/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, statusVersion: "v3-hierarchical" });
    return;
  }

  if (url.pathname === "/status" && request.method === "GET") {
    sendJson(response, 200, store.getStatus());
    return;
  }

  if (url.pathname === "/statuses" && request.method === "GET") {
    sendJson(response, 200, store.getStatuses(url.searchParams.get("includeHidden") === "true"));
    return;
  }

  if (url.pathname === "/sessions" && request.method === "GET") {
    const includeHidden = url.searchParams.get("includeHidden") === "true";
    const sessions = store
      .getSessions()
      .filter((session) => includeHidden || session.visibility !== "dismissed")
      .sort(compareStateThenUpdatedAt);
    sendJson(response, 200, sessions);
    return;
  }

  if (url.pathname === "/events" && request.method === "GET") {
    sendJson(response, 200, store.getEvents());
    return;
  }

  if (url.pathname === "/diagnostics" && request.method === "GET") {
    sendJson(response, 200, store.getDiagnostics());
    return;
  }

  if (url.pathname === "/status" && request.method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, store.update(body));
    return;
  }

  if (url.pathname === "/session" && ["DELETE", "POST"].includes(request.method ?? "")) {
    const body = await readOptionalJsonBody(request);
    const id = text(asRecord(body)?.id) || text(url.searchParams.get("id"));
    if (!id) {
      sendJson(response, 400, { error: "id is required" });
      return;
    }

    sendJson(response, 200, store.deleteSession(id));
    return;
  }

  if (url.pathname === "/dismiss-session" && request.method === "POST") {
    const body = await readJsonBody(request);
    const id = text(asRecord(body)?.id);
    if (!id) {
      sendJson(response, 400, { error: "id is required" });
      return;
    }

    sendJson(response, 200, store.dismissSession(id));
    return;
  }

  if (url.pathname === "/session-title" && request.method === "POST") {
    const body = asRecord(await readJsonBody(request));
    const id = text(body?.id);
    const title = text(body?.title);
    if (!id || !title) {
      sendJson(response, 400, { error: "id and title are required" });
      return;
    }

    sendJson(response, 200, store.updateSessionTitle(id, title));
    return;
  }

  if (url.pathname === "/project" && ["DELETE", "POST"].includes(request.method ?? "")) {
    const body = await readOptionalJsonBody(request);
    const projectId = text(asRecord(body)?.projectId) || text(url.searchParams.get("projectId"));
    if (!projectId) {
      sendJson(response, 400, { error: "projectId is required" });
      return;
    }

    sendJson(response, 200, store.deleteProject(projectId));
    return;
  }

  if (url.pathname === "/dismiss-project" && request.method === "POST") {
    const body = await readJsonBody(request);
    const projectId = text(asRecord(body)?.projectId);
    if (!projectId) {
      sendJson(response, 400, { error: "projectId is required" });
      return;
    }

    sendJson(response, 200, store.dismissProject(projectId));
    return;
  }

  if (url.pathname === "/clear-done" && request.method === "POST") {
    sendJson(response, 200, store.clearDone());
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function readJsonBody(request: IncomingMessage): Promise<StatusUpdateInput | Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as StatusUpdateInput;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readOptionalJsonBody(
  request: IncomingMessage
): Promise<StatusUpdateInput | Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as StatusUpdateInput;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  applyCors(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function applyCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function compareProjectStateThenUpdatedAt(a: ProjectStatus, b: ProjectStatus): number {
  return compareByStateThenUpdatedAt(a.state, a.updatedAt, b.state, b.updatedAt);
}

function compareStateThenUpdatedAt(a: SessionStatus, b: SessionStatus): number {
  return compareByStateThenUpdatedAt(a.state, a.updatedAt, b.state, b.updatedAt);
}

function compareByStateThenUpdatedAt(
  aState: AgentState,
  aUpdatedAt: number,
  bState: AgentState,
  bUpdatedAt: number
): number {
  const priorityDelta = STATE_PRIORITY[bState] - STATE_PRIORITY[aState];
  return priorityDelta || bUpdatedAt - aUpdatedAt;
}

function countStates(sessions: SessionStatus[]): Record<AgentState, number> {
  const counts = emptyCounts();
  for (const session of sessions) {
    counts[session.state] += 1;
  }

  return counts;
}

function highestState(states: AgentState[]): AgentState {
  return states.reduce<AgentState>(
    (highest, state) => (STATE_PRIORITY[state] > STATE_PRIORITY[highest] ? state : highest),
    "idle"
  );
}

function defaultMessage(state: AgentState): string {
  switch (state) {
    case "running":
      return "Codex is running";
    case "waiting_approval":
      return "Codex needs approval";
    case "done":
      return "Codex finished";
    case "error":
      return "Codex reported an error";
    case "stale":
      return "No status update received recently";
    case "idle":
    default:
      return "Codex is idle";
  }
}

function displayNameFromProject(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.includes("/") ? path.basename(value) : value;
}

function makeDisplayTitle(session: SessionStatus): string {
  return (
    displayText(session.title) ||
    displayText(session.sessionName) ||
    displayText(session.firstUserPromptSummary) ||
    displayText(session.commandSummary) ||
    shortSessionId(session.sessionId) ||
    `${session.projectName} session`
  );
}

function shortSessionId(sessionId: string): string | undefined {
  if (!sessionId || isDefaultSessionId(sessionId)) {
    return undefined;
  }

  return sessionId.length > 12 ? sessionId.slice(0, 12) : sessionId;
}

function isDefaultSessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.includes("default-session"));
}

function shouldRedisplay(next: SessionStatus, previous: SessionStatus | undefined): boolean {
  if (previous?.visibility !== "dismissed") {
    return true;
  }

  if (next.source === "system") {
    return false;
  }

  return ["waiting_approval", "error", "running", "done"].includes(next.state);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayText(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate || candidate.includes("default-session")) {
    return undefined;
  }

  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeUndefined(value: SessionStatus): SessionStatus {
  const next = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (typeof next[key] === "undefined") {
      delete next[key];
    }
  }

  return next as unknown as SessionStatus;
}
