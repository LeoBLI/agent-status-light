import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import {
  AgentState,
  ApprovalMode,
  AppConfig,
  Diagnostics,
  OpenSessionResult,
  ProjectStatus,
  SessionStatus,
  STATE_PRIORITY,
  StatusTree,
  StatusUpdateInput,
  VALID_SOURCES,
  VALID_STATES,
  emptyCounts,
} from "../shared/types";
import {
  codexThreadDeepLink,
  enrichFromCodexSessionIndex,
  getCodexSessionIndexDiagnostics,
  isCodexThreadId,
} from "./codex-session-index";

const execFileAsync = promisify(execFile);

interface StatusEvents {
  status: [StatusTree, SessionStatus, SessionStatus | undefined];
}

interface StatusStoreOptions {
  staleTimeoutMs?: number;
  doneToIdleMs?: number;
  codexAppName?: string;
  codexBundleId?: string;
  titleOverridesPath?: string;
  projectNameOverridesPath?: string;
}

interface SessionTimers {
  stale?: NodeJS.Timeout;
  approval?: NodeJS.Timeout;
}

const APPROVAL_GRACE_MS = positiveNumber(
  process.env.AGENTWATCH_APPROVAL_GRACE_MS,
  30_000,
);

export class StatusStore extends EventEmitter {
  private readonly sessions = new Map<string, SessionStatus>();
  private readonly timers = new Map<string, SessionTimers>();
  private readonly events: SessionStatus[] = [];
  private readonly createdAt = Date.now();
  private readonly staleTimeoutMs: number;
  private readonly codexAppName: string;
  private readonly codexBundleId: string;
  private readonly titleOverridesPath: string | undefined;
  private readonly titleOverrides = new Map<string, string>();
  private readonly projectNameOverridesPath: string | undefined;
  private readonly projectNameOverrides = new Map<string, string>();

  constructor(options: StatusStoreOptions = {}) {
    super();
    this.staleTimeoutMs = options.staleTimeoutMs ?? 10 * 60 * 1000;
    this.codexAppName = options.codexAppName || "Codex";
    this.codexBundleId = options.codexBundleId || "com.openai.codex";
    this.titleOverridesPath = options.titleOverridesPath;
    this.projectNameOverridesPath = options.projectNameOverridesPath;
    this.loadTitleOverrides();
    this.loadProjectNameOverrides();
  }

  override on<K extends keyof StatusEvents>(
    eventName: K,
    listener: (...args: StatusEvents[K]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  getStatus(): StatusTree["overall"] {
    return this.getStatuses(false).overall;
  }

  getStatuses(includeHidden = false): StatusTree {
    const projectsById = new Map<string, SessionStatus[]>();

    for (const storedSession of this.sessions.values()) {
      const session = withFreshProjectPathExists(storedSession);
      if (!includeHidden && session.visibility === "dismissed") {
        continue;
      }

      const projectSessions = projectsById.get(session.projectId) ?? [];
      projectSessions.push(session);
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
          updatedAt: Math.max(
            ...sortedSessions.map((session) => session.updatedAt),
          ),
          sessions: sortedSessions,
          counts,
        };
      },
    );

    projects.sort(compareProjectStateThenUpdatedAt);

    const allSessions = Array.from(this.sessions.values())
      .map(withFreshProjectPathExists)
      .filter((session) => includeHidden || session.visibility !== "dismissed");
    const overallCounts = countStates(allSessions);
    const approvalMode = approvalModeForSessions(allSessions);
    const visibleApprovalRequiredCount = allSessions.filter(
      isManualApprovalRequired,
    ).length;

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
        approvalMode,
        visibleApprovalRequiredCount,
        doneCount: overallCounts.done,
        runningCount: overallCounts.running,
        errorCount: overallCounts.error,
        staleCount: overallCounts.stale,
      },
      projects,
    };
  }

  getSessions(): SessionStatus[] {
    return Array.from(this.sessions.values()).map(withFreshProjectPathExists);
  }

  getEvents(): SessionStatus[] {
    return this.events.map((event) => ({ ...event }));
  }

  getDiagnostics(): Diagnostics {
    const hookEvents = this.events.filter(
      (event) => event.source === "codex-hook",
    );
    const lastHookEvent = hookEvents.at(-1);
    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;

    const visibleSessions = this.getSessions().filter(
      (session) => session.visibility !== "dismissed",
    );
    const visibleApprovalRequiredCount = visibleSessions.filter(
      isManualApprovalRequired,
    ).length;
    const autoApprovalEventCount = this.events.filter(
      (session) => session.approvalMode === "auto",
    ).length;

    return {
      ok: true,
      serviceName: "AgentWatch",
      statusVersion: "v3-hierarchical",
      currentStatus: this.getStatus(),
      hookHealth: {
        lastHookEventAt: lastHookEvent?.updatedAt,
        lastHookState: lastHookEvent?.state,
        isHookRecentlyActive: Boolean(
          lastHookEvent && now - lastHookEvent.updatedAt <= tenMinutesMs,
        ),
      },
      eventsCount: this.events.length,
      autoTransitions: {
        doneDisplayMs: 0,
        staleTimeoutMs: this.staleTimeoutMs,
      },
      stateSemantics: {
        doneAutoDismiss: false,
        postToolUseMarksDone: false,
        staleTimeoutMs: this.staleTimeoutMs,
        missingPathCleanupAvailable: true,
      },
      visibleWaitingApprovalCount: visibleSessions.filter(
        (session) => session.state === "waiting_approval",
      ).length,
      approvalMode: approvalModeForSessions(visibleSessions),
      visibleApprovalRequiredCount,
      autoApprovalEventCount,
      manualApprovalRequiredCount: visibleApprovalRequiredCount,
      dismissAllDoneAvailable: true,
      detailsPanelAvailable: true,
      approveAllApprovalAvailable: false,
      approveActionReason: "approve_action_not_available",
      visibleStaleCount: visibleSessions.filter(
        (session) => session.state === "stale",
      ).length,
      visibleErrorCount: visibleSessions.filter(
        (session) => session.state === "error",
      ).length,
      missingProjectPathSessionCount: visibleSessions.filter(
        (session) => session.projectPath && session.projectPathExists === false,
      ).length,
      codexOpenSupport: {
        appName: this.codexAppName,
        bundleId: this.codexBundleId,
        deeplinkScheme: "codex://",
        sessionIndexFound: getCodexSessionIndexDiagnostics().found,
        sessionIndexPath: getCodexSessionIndexDiagnostics().path,
        threadDeepLinkSupport: "best-effort",
      },
    };
  }

  update(input: StatusUpdateInput): {
    session: SessionStatus;
    project: ProjectStatus | undefined;
    overall: StatusTree["overall"];
  } {
    const session = this.normalizeInput(input);
    const previous = this.sessions.get(session.id);
    const next = this.withCodexOpenTarget(this.mergeSession(session, previous));

    if (shouldDelayApprovalEscalation(input, next)) {
      const pending = this.withCodexOpenTarget(
        this.mergeSession(pendingApprovalSession(next), previous),
      );
      this.applySession(pending, previous);
      this.dismissLegacyDefaultSessions(pending);
      this.scheduleApprovalEscalation(pending, next);
      this.scheduleAutomaticTransitions(pending);

      const tree = this.getStatuses();
      return {
        session: pending,
        project: tree.projects.find(
          (project) => project.projectId === pending.projectId,
        ),
        overall: tree.overall,
      };
    }

    this.applySession(next, previous);
    this.dismissLegacyDefaultSessions(next);
    this.scheduleAutomaticTransitions(next);

    const tree = this.getStatuses();
    return {
      session: next,
      project: tree.projects.find(
        (project) => project.projectId === next.projectId,
      ),
      overall: tree.overall,
    };
  }

  async openSession(id: string): Promise<OpenSessionResult> {
    const session = this.sessions.get(id);
    if (!session) {
      return {
        ok: false,
        opened: false,
        strategy: "failed",
        fallbackUsed: false,
        message: "Session not found.",
      };
    }

    const deeplink = session.codexDeepLink;

    if (deeplink) {
      try {
        await openCodexDeepLink(
          deeplink,
          this.codexBundleId,
          this.codexAppName,
        );
        return {
          ok: true,
          opened: true,
          strategy: "deeplink",
          target: deeplink,
          fallbackUsed: false,
          message: "Opened Codex thread deeplink.",
        };
      } catch {
        const fallback = await openCodexApp(
          this.codexAppName,
          this.codexBundleId,
        );
        return {
          ok: fallback,
          opened: fallback,
          strategy: fallback ? "open-app" : "failed",
          target: fallback ? this.codexAppName : deeplink,
          fallbackUsed: true,
          message: fallback
            ? "Opened Codex app. Exact thread deeplink was unavailable."
            : "Could not open Codex automatically.",
        };
      }
    }

    const opened = await openCodexApp(this.codexAppName, this.codexBundleId);
    return {
      ok: opened,
      opened,
      strategy: opened ? "open-app" : "failed",
      target: this.codexAppName,
      fallbackUsed: true,
      message: opened
        ? "Opened Codex app. Exact thread deeplink was unavailable."
        : "Could not open Codex automatically.",
    };
  }

  deleteSession(id: string): {
    deletedCount: number;
    deletedSessionIds: string[];
    tree: StatusTree;
  } {
    const existed = this.sessions.has(id);
    this.clearTimers(id);
    this.sessions.delete(id);
    return {
      deletedCount: existed ? 1 : 0,
      deletedSessionIds: existed ? [id] : [],
      tree: this.getStatuses(),
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
      tree: this.getStatuses(),
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
      return {
        ok: true,
        dismissedCount: 0,
        dismissedSessionIds: [],
        tree: this.getStatuses(),
      };
    }

    const previous = { ...session };
    const next = {
      ...session,
      visibility: "dismissed" as const,
      dismissedAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.applySession(next, previous);
    return {
      ok: true,
      dismissedCount: 1,
      dismissedSessionIds: [id],
      tree: this.getStatuses(),
    };
  }

  updateSessionTitle(
    id: string,
    title: string,
  ): {
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
      updatedAt: Date.now(),
    });

    this.applySession(next, previous);
    this.scheduleAutomaticTransitions(next);
    return {
      ok: true,
      updatedCount: 1,
      session: next,
      tree: this.getStatuses(),
    };
  }

  updateProjectName(
    projectId: string,
    projectName: string,
  ): {
    ok: true;
    updatedCount: number;
    project?: ProjectStatus;
    tree: StatusTree;
  } {
    this.projectNameOverrides.set(projectId, projectName);
    this.saveProjectNameOverrides();

    let updatedCount = 0;
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        const previous = { ...session };
        const next = {
          ...session,
          projectName,
          updatedAt: Date.now(),
        };
        this.applySession(next, previous);
        this.scheduleAutomaticTransitions(next);
        updatedCount += 1;
      }
    }

    const tree = this.getStatuses();
    return {
      ok: true,
      updatedCount,
      project: tree.projects.find((project) => project.projectId === projectId),
      tree,
    };
  }

  dismissProject(projectId: string): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    const dismissedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (
        session.projectId === projectId &&
        session.visibility !== "dismissed"
      ) {
        const previous = { ...session };
        const next = {
          ...session,
          visibility: "dismissed" as const,
          dismissedAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.applySession(next, previous);
        dismissedSessionIds.push(session.id);
      }
    }

    return {
      ok: true,
      dismissedCount: dismissedSessionIds.length,
      dismissedSessionIds,
      tree: this.getStatuses(),
    };
  }

  dismissProjectPath(projectPath: string): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    return this.dismissMatchingSessions(
      (session) =>
        session.projectPath === projectPath &&
        session.visibility !== "dismissed",
    );
  }

  cleanupMissingPaths(): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    return this.dismissMatchingSessions(
      (session) =>
        Boolean(session.projectPath) &&
        session.visibility !== "dismissed" &&
        projectPathExists(session.projectPath) === false,
    );
  }

  private dismissMatchingSessions(
    predicate: (session: SessionStatus) => boolean,
  ): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    const dismissedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (predicate(session)) {
        const previous = { ...session };
        const next = {
          ...session,
          projectPathExists: session.projectPath
            ? projectPathExists(session.projectPath)
            : undefined,
          visibility: "dismissed" as const,
          dismissedAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.applySession(next, previous);
        dismissedSessionIds.push(session.id);
      }
    }

    return {
      ok: true,
      dismissedCount: dismissedSessionIds.length,
      dismissedSessionIds,
      tree: this.getStatuses(),
    };
  }

  clearDone(): {
    ok: true;
    dismissedCount: number;
    dismissedSessionIds: string[];
    tree: StatusTree;
  } {
    const dismissedSessionIds: string[] = [];

    for (const session of this.sessions.values()) {
      if (session.state === "done" && session.visibility !== "dismissed") {
        const previous = { ...session };
        const next = {
          ...session,
          visibility: "dismissed" as const,
          dismissedAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.applySession(next, previous);
        dismissedSessionIds.push(session.id);
      }
    }

    return {
      ok: true,
      dismissedCount: dismissedSessionIds.length,
      dismissedSessionIds,
      tree: this.getStatuses(),
    };
  }

  markSessionDone(id: string): {
    ok: boolean;
    reasonCode?: string;
    reasonMessage?: string;
    tree: StatusTree;
  } {
    const session = this.sessions.get(id);
    if (!session) {
      return {
        ok: false,
        reasonCode: "session_not_found",
        reasonMessage: "Session not found",
        tree: this.getStatuses(),
      };
    }

    const now = Date.now();
    const previous = { ...session };
    const next = removeUndefined({
      ...session,
      state: "done" as const,
      source: "manual" as const,
      message: "Marked done",
      reasonCode: "manual_done",
      reasonMessage: "Marked done",
      approvalRequired: false,
      lastCompletedAt: now,
      updatedAt: now,
    });

    this.applySession(next, previous);
    return {
      ok: true,
      tree: this.getStatuses(),
    };
  }

  approveAllApproval(): {
    ok: false;
    reasonCode: "approve_action_not_available";
    reasonMessage: string;
    approvedCount: number;
    failedCount: number;
    results: Array<{
      sessionId: string;
      ok: false;
      reasonCode: "approve_action_not_available";
      reasonMessage: string;
    }>;
    tree: StatusTree;
  } {
    const reasonMessage = "Approve action is not available yet";
    const sessions = this.getSessions().filter(isManualApprovalRequired);

    return {
      ok: false,
      reasonCode: "approve_action_not_available",
      reasonMessage,
      approvedCount: 0,
      failedCount: sessions.length,
      results: sessions.map((session) => ({
        sessionId: session.id,
        ok: false,
        reasonCode: "approve_action_not_available",
        reasonMessage,
      })),
      tree: this.getStatuses(),
    };
  }

  private normalizeInput(input: StatusUpdateInput): SessionStatus {
    if (!input.state || !VALID_STATES.includes(input.state)) {
      throw new Error(
        `Invalid state. Expected one of: ${VALID_STATES.join(", ")}`,
      );
    }

    const raw = asRecord(input.raw);
    const projectPath = text(input.projectPath) || text(raw?.cwd);
    const projectValue = text(input.project);
    const projectId =
      text(input.projectId) ||
      projectPath ||
      projectValue ||
      text(raw?.cwd) ||
      "unknown-project";
    const inferredProjectName =
      text(input.projectName) ||
      displayNameFromProject(projectValue) ||
      displayNameFromProject(projectPath) ||
      projectValue ||
      "Unknown Project";
    const projectName =
      this.projectNameOverrides.get(projectId) || inferredProjectName;
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
    const title =
      text(input.title) || text(raw?.title) || this.titleOverrides.get(id);
    const promptFileName =
      text(input.promptFileName) || promptFileNameFromRaw(raw);
    const filePromptTitle =
      text(input.filePromptTitle) ||
      (promptFileName ? `File: ${promptFileName}` : undefined);
    const sessionName = text(input.sessionName) || title || undefined;
    const source =
      input.source && VALID_SOURCES.includes(input.source)
        ? input.source
        : "manual";
    const now = Date.now();
    const quotaLimited = hasQuotaLimitSignal(input, raw);
    const lastHookEvent =
      text(input.lastHookEvent) || text(raw?.hook_event_name);
    const lastUserPrompt =
      text(input.lastUserPrompt) || userPromptFromRaw(raw);
    const firstUserPromptSummary =
      text(input.firstUserPromptSummary) ||
      (lastUserPrompt ? summarizeText(lastUserPrompt) : undefined);
    const lastCommandSummary =
      text(input.lastCommandSummary) ||
      text(input.commandSummary) ||
      commandSummaryFromRaw(raw);
    const approval = approvalMetadataForInput({
      input,
      raw,
      requestedState: input.state,
      lastHookEvent,
      lastCommandSummary,
    });
    const state = quotaLimited
      ? "error"
      : input.state === "waiting_approval" && !approval.approvalRequired
        ? "running"
        : input.state;
    const message = quotaLimited
      ? quotaLimitMessage(input.message)
      : input.state === "waiting_approval" && !approval.approvalRequired
        ? text(input.message) || "Auto approval event recorded"
      : text(input.message) || defaultMessage(state);
    const lastCwd = text(input.lastCwd) || text(raw?.cwd) || projectPath;
    const reason = reasonForStatus({
      state,
      message,
      reasonCode: input.reasonCode,
      reasonMessage: input.reasonMessage,
      lastHookEvent,
      lastCommandSummary,
      approvalRequired: approval.approvalRequired,
    });

    return {
      id,
      agent: text(input.agent) || "codex",
      projectId,
      projectName,
      projectPath,
      sessionId,
      sessionName,
      title,
      filePromptTitle,
      lastUserPrompt,
      firstUserPromptSummary,
      lastUserPromptAt:
        typeof input.lastUserPromptAt === "number"
          ? input.lastUserPromptAt
          : lastUserPrompt
            ? now
            : undefined,
      promptInputType: input.promptInputType || (promptFileName ? "file" : lastUserPrompt ? "text" : undefined),
      promptFileName,
      commandSummary: text(input.commandSummary) || lastCommandSummary,
      state,
      source,
      message,
      reasonCode: reason.reasonCode,
      reasonMessage: reason.reasonMessage,
      lastHookEvent,
      lastCommandSummary,
      lastCwd,
      projectPathExists:
        typeof input.projectPathExists === "boolean"
          ? input.projectPathExists
          : projectPath
            ? projectPathExists(projectPath)
            : undefined,
      approvalMode: approval.approvalMode,
      approvalRequired: approval.approvalRequired,
      approvalRequestSummary: approval.approvalRequestSummary,
      approvalRequestDetails: approval.approvalRequestDetails,
      approvalLastEvent: approval.approvalLastEvent,
      updatedAt: now,
      createdAt: now,
      visibility: "visible",
      codexThreadId: pickCodexThreadId(input, raw),
      codexSessionId: pickCodexSessionId(input, raw),
      codexSessionPath:
        text(input.codexSessionPath) || text(raw?.codexSessionPath),
      codexDeepLink: cleanCodexDeepLink(
        text(input.codexDeepLink) || text(raw?.codexDeepLink),
      ),
      raw: input.raw,
    };
  }

  private mergeSession(
    next: SessionStatus,
    previous: SessionStatus | undefined,
  ): SessionStatus {
    const merged: SessionStatus = {
      ...previous,
      ...next,
      createdAt: previous?.createdAt ?? next.createdAt,
      projectName:
        next.projectName || previous?.projectName || "Unknown Project",
      projectPath: next.projectPath ?? previous?.projectPath,
      sessionName: next.sessionName ?? previous?.sessionName,
      title: next.title ?? previous?.title,
      filePromptTitle: next.filePromptTitle ?? previous?.filePromptTitle,
      lastUserPrompt: next.lastUserPrompt ?? previous?.lastUserPrompt,
      firstUserPromptSummary:
        next.firstUserPromptSummary ?? previous?.firstUserPromptSummary,
      lastUserPromptAt: next.lastUserPromptAt ?? previous?.lastUserPromptAt,
      promptInputType: next.promptInputType ?? previous?.promptInputType,
      promptFileName: next.promptFileName ?? previous?.promptFileName,
      commandSummary: next.commandSummary ?? previous?.commandSummary,
      reasonCode: next.reasonCode ?? previous?.reasonCode,
      reasonMessage: next.reasonMessage ?? previous?.reasonMessage,
      lastHookEvent: next.lastHookEvent ?? previous?.lastHookEvent,
      lastCommandSummary:
        next.lastCommandSummary ?? previous?.lastCommandSummary,
      lastCwd: next.lastCwd ?? previous?.lastCwd,
      projectPathExists: next.projectPathExists ?? previous?.projectPathExists,
      approvalMode: next.approvalMode ?? previous?.approvalMode,
      approvalRequired: next.approvalRequired ?? previous?.approvalRequired,
      approvalRequestSummary:
        next.approvalRequestSummary ?? previous?.approvalRequestSummary,
      approvalRequestDetails:
        next.approvalRequestDetails ?? previous?.approvalRequestDetails,
      approvalLastEvent: next.approvalLastEvent ?? previous?.approvalLastEvent,
      visibility: previous?.visibility ?? next.visibility ?? "visible",
      dismissedAt: previous?.dismissedAt,
      lastCompletedAt: previous?.lastCompletedAt,
      lastApprovalAt: previous?.lastApprovalAt,
      codexThreadId: next.codexThreadId ?? previous?.codexThreadId,
      codexSessionId: next.codexSessionId ?? previous?.codexSessionId,
      codexSessionPath: next.codexSessionPath ?? previous?.codexSessionPath,
      codexDeepLink: next.codexDeepLink ?? previous?.codexDeepLink,
      openTarget: next.openTarget ?? previous?.openTarget,
    };

    if (shouldRedisplay(next, previous)) {
      merged.visibility = "visible";
      delete merged.dismissedAt;
    }

    if (next.state === "idle") {
      merged.visibility = "dismissed";
      merged.dismissedAt = next.updatedAt;
    }

    if (next.state === "done") {
      merged.lastCompletedAt = next.updatedAt;
    }

    if (next.state === "waiting_approval" && next.approvalRequired === true) {
      merged.lastApprovalAt = next.updatedAt;
    }

    merged.displayTitle = makeDisplayTitle(merged);
    return removeUndefined(merged);
  }

  private withCodexOpenTarget(session: SessionStatus): SessionStatus {
    const indexed = enrichFromCodexSessionIndex(session);
    const codexThreadId = session.codexThreadId ?? indexed.codexThreadId;
    const codexDeepLink =
      cleanCodexDeepLink(session.codexDeepLink) ||
      codexThreadDeepLink(codexThreadId) ||
      cleanCodexDeepLink(indexed.codexDeepLink);

    return removeUndefined({
      ...session,
      codexThreadId,
      codexSessionId: session.codexSessionId,
      codexSessionPath: session.codexSessionPath ?? indexed.codexSessionPath,
      codexDeepLink,
      openTarget: codexDeepLink
        ? {
            type: "codex-thread" as const,
            url: codexDeepLink,
          }
        : {
            type: "codex-app" as const,
            appName: this.codexAppName,
            fallbackReason: "Exact thread deeplink unavailable.",
          },
    });
  }

  private applySession(
    next: SessionStatus,
    previous: SessionStatus | undefined,
  ): void {
    this.clearTimers(next.id);
    this.sessions.set(next.id, next);
    this.events.push({ ...next });

    if (this.events.length > 500) {
      this.events.splice(0, this.events.length - 500);
    }

    this.emit(
      "status",
      this.getStatuses(),
      { ...next },
      previous ? { ...previous } : undefined,
    );
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
          updatedAt: next.updatedAt,
        };
        this.applySession(dismissed, previous);
      }
    }
  }

  private scheduleAutomaticTransitions(session: SessionStatus): void {
    if (session.state === "running") {
      this.setTimer(
        session.id,
        "stale",
        () => {
          const current = this.sessions.get(session.id);
          if (
            current?.state === "running" &&
            current.updatedAt === session.updatedAt
          ) {
            const quotaLimited = hasQuotaLimitSignal(
              current,
              asRecord(current.raw),
            );
            this.update({
              agent: current.agent,
              projectId: current.projectId,
              projectName: current.projectName,
              projectPath: current.projectPath,
              sessionId: current.sessionId,
              sessionName: current.sessionName,
              title: current.title,
              state: quotaLimited ? "error" : "stale",
              source: "system",
              message: quotaLimited
                ? "Codex quota or usage limit reached"
                : "No status update after running",
              lastHookEvent: current.lastHookEvent,
              lastCommandSummary:
                current.lastCommandSummary || current.commandSummary,
              lastCwd: current.lastCwd,
              approvalMode: current.approvalMode,
              approvalRequired: current.approvalRequired,
              approvalRequestSummary: current.approvalRequestSummary,
              approvalRequestDetails: current.approvalRequestDetails,
              approvalLastEvent: current.approvalLastEvent,
              raw: current.raw,
            });
          }
        },
        this.staleTimeoutMs,
      );
    }
  }

  private scheduleApprovalEscalation(
    pending: SessionStatus,
    approval: SessionStatus,
  ): void {
    this.setTimer(
      pending.id,
      "approval",
      () => {
        const current = this.sessions.get(pending.id);
        if (
          current?.updatedAt === pending.updatedAt &&
          current.state === "running" &&
          current.approvalLastEvent === "PermissionRequest"
        ) {
          const previous = { ...current };
          const next = this.withCodexOpenTarget(
            this.mergeSession(
              {
                ...approval,
                updatedAt: Date.now(),
                visibility: "visible",
              },
              current,
            ),
          );
          this.applySession(next, previous);
          this.dismissLegacyDefaultSessions(next);
        }
      },
      APPROVAL_GRACE_MS,
    );
  }

  private setTimer(
    id: string,
    key: keyof SessionTimers,
    callback: () => void,
    delayMs: number,
  ): void {
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

    if (timers.approval) {
      clearTimeout(timers.approval);
    }

    this.timers.delete(id);
  }

  private loadTitleOverrides(): void {
    if (!this.titleOverridesPath || !existsSync(this.titleOverridesPath)) {
      return;
    }

    try {
      const data = JSON.parse(
        readFileSync(this.titleOverridesPath, "utf8"),
      ) as unknown;
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

  private loadProjectNameOverrides(): void {
    if (
      !this.projectNameOverridesPath ||
      !existsSync(this.projectNameOverridesPath)
    ) {
      return;
    }

    try {
      const data = JSON.parse(
        readFileSync(this.projectNameOverridesPath, "utf8"),
      ) as unknown;
      const records = asRecord(data);
      for (const [projectId, projectName] of Object.entries(records ?? {})) {
        const cleanProjectName = text(projectName);
        if (cleanProjectName) {
          this.projectNameOverrides.set(projectId, cleanProjectName);
        }
      }
    } catch (error) {
      console.warn("Failed to load project name overrides:", error);
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
        "utf8",
      );
    } catch (error) {
      console.warn("Failed to save session title overrides:", error);
    }
  }

  private saveProjectNameOverrides(): void {
    if (!this.projectNameOverridesPath) {
      return;
    }

    try {
      mkdirSync(path.dirname(this.projectNameOverridesPath), {
        recursive: true,
      });
      writeFileSync(
        this.projectNameOverridesPath,
        `${JSON.stringify(Object.fromEntries(this.projectNameOverrides), null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      console.warn("Failed to save project name overrides:", error);
    }
  }
}

export function startStatusServer(
  config: AppConfig,
  store: StatusStore,
): Promise<http.Server> {
  const server = http.createServer(async (request, response) => {
    try {
      await routeRequest(request, response, store);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected server error";
      sendJson(response, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      console.log(`AgentWatch listening at http://localhost:${config.port}`);
      resolve(server);
    });
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: StatusStore,
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
    sendJson(
      response,
      200,
      store.getStatuses(url.searchParams.get("includeHidden") === "true"),
    );
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

  if (url.pathname === "/open-session" && request.method === "POST") {
    const body = asRecord(await readJsonBody(request));
    const id = text(body?.id);
    if (!id) {
      sendJson(response, 400, { error: "id is required" });
      return;
    }

    sendJson(response, 200, await store.openSession(id));
    return;
  }

  if (
    url.pathname === "/session" &&
    ["DELETE", "POST"].includes(request.method ?? "")
  ) {
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

  if (url.pathname === "/project-name" && request.method === "POST") {
    const body = asRecord(await readJsonBody(request));
    const projectId = text(body?.projectId);
    const projectName = text(body?.projectName);
    if (!projectId || !projectName) {
      sendJson(response, 400, {
        error: "projectId and projectName are required",
      });
      return;
    }

    sendJson(response, 200, store.updateProjectName(projectId, projectName));
    return;
  }

  if (
    url.pathname === "/project" &&
    ["DELETE", "POST"].includes(request.method ?? "")
  ) {
    const body = await readOptionalJsonBody(request);
    const projectId =
      text(asRecord(body)?.projectId) ||
      text(url.searchParams.get("projectId"));
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

  if (url.pathname === "/dismiss-project-path" && request.method === "POST") {
    const body = await readJsonBody(request);
    const projectPath = text(asRecord(body)?.projectPath);
    if (!projectPath) {
      sendJson(response, 400, { error: "projectPath is required" });
      return;
    }

    sendJson(response, 200, store.dismissProjectPath(projectPath));
    return;
  }

  if (url.pathname === "/cleanup-missing-paths" && request.method === "POST") {
    sendJson(response, 200, store.cleanupMissingPaths());
    return;
  }

  if (url.pathname === "/dismiss-all-done" && request.method === "POST") {
    sendJson(response, 200, store.clearDone());
    return;
  }

  if (url.pathname === "/approve-all-approval" && request.method === "POST") {
    sendJson(response, 200, store.approveAllApproval());
    return;
  }

  if (url.pathname === "/clear-done" && request.method === "POST") {
    sendJson(response, 200, store.clearDone());
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<StatusUpdateInput | Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as StatusUpdateInput;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readOptionalJsonBody(
  request: IncomingMessage,
): Promise<StatusUpdateInput | Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as StatusUpdateInput;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  applyCors(response);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function applyCors(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function compareProjectStateThenUpdatedAt(
  a: ProjectStatus,
  b: ProjectStatus,
): number {
  return compareByStateThenUpdatedAt(
    a.state,
    a.updatedAt,
    b.state,
    b.updatedAt,
  );
}

function compareStateThenUpdatedAt(a: SessionStatus, b: SessionStatus): number {
  return compareByStateThenUpdatedAt(
    a.state,
    a.updatedAt,
    b.state,
    b.updatedAt,
  );
}

function compareByStateThenUpdatedAt(
  aState: AgentState,
  aUpdatedAt: number,
  bState: AgentState,
  bUpdatedAt: number,
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
    (highest, state) =>
      STATE_PRIORITY[state] > STATE_PRIORITY[highest] ? state : highest,
    "idle",
  );
}

function withFreshProjectPathExists(session: SessionStatus): SessionStatus {
  if (!session.projectPath) {
    return { ...session };
  }

  return {
    ...session,
    projectPathExists: projectPathExists(session.projectPath),
  };
}

function projectPathExists(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return existsSync(value);
  } catch {
    return false;
  }
}

function isManualApprovalRequired(session: SessionStatus): boolean {
  return (
    session.visibility !== "dismissed" &&
    session.state === "waiting_approval" &&
    session.approvalRequired === true
  );
}

function shouldDelayApprovalEscalation(
  input: StatusUpdateInput,
  session: SessionStatus,
): boolean {
  const raw = asRecord(input.raw);
  const explicitRequired = booleanValue(
    input.approvalRequired,
    raw?.approvalRequired,
    raw?.approval_required,
    readPath(raw, ["approval", "required"]),
    readPath(raw, ["permission_request", "required"]),
  );
  const explicitMode = approvalModeValue(
    input.approvalMode,
    raw?.approvalMode,
    raw?.approval_mode,
    readPath(raw, ["approval", "mode"]),
    readPath(raw, ["permission_request", "mode"]),
  );

  return (
    session.source === "codex-hook" &&
    session.state === "waiting_approval" &&
    session.lastHookEvent === "PermissionRequest" &&
    explicitRequired !== true &&
    explicitMode !== "manual"
  );
}

function pendingApprovalSession(session: SessionStatus): SessionStatus {
  return removeUndefined({
    ...session,
    state: "running" as const,
    message: "Codex is running",
    reasonCode: "agent_running",
    reasonMessage: "Agent is running",
    approvalMode: session.approvalMode === "auto" ? "auto" : "unknown",
    approvalRequired: false,
  });
}

function approvalModeForSessions(sessions: SessionStatus[]): ApprovalMode {
  if (sessions.some(isManualApprovalRequired)) {
    return "manual";
  }

  if (sessions.some((session) => session.approvalMode === "auto")) {
    return "auto";
  }

  return "unknown";
}

function approvalMetadataForInput({
  input,
  raw,
  requestedState,
  lastHookEvent,
  lastCommandSummary,
}: {
  input: StatusUpdateInput;
  raw: Record<string, unknown> | undefined;
  requestedState: AgentState;
  lastHookEvent?: string;
  lastCommandSummary?: string;
}): {
  approvalMode: ApprovalMode;
  approvalRequired: boolean;
  approvalRequestSummary?: string;
  approvalRequestDetails?: string;
  approvalLastEvent?: string;
} {
  const explicitMode = approvalModeValue(
    input.approvalMode,
    raw?.approvalMode,
    raw?.approval_mode,
    readPath(raw, ["approval", "mode"]),
    readPath(raw, ["permission_request", "mode"]),
  );
  const explicitRequired = booleanValue(
    input.approvalRequired,
    raw?.approvalRequired,
    raw?.approval_required,
    readPath(raw, ["approval", "required"]),
    readPath(raw, ["permission_request", "required"]),
  );
  const approvalText = [
    text(input.message),
    text(input.reasonMessage),
    text(raw?.message),
    text(raw?.approvalMode),
    text(raw?.approval_mode),
    text(readPath(raw, ["approval", "mode"])),
    text(readPath(raw, ["permission_request", "mode"])),
    text(readPath(raw, ["permission_request", "status"])),
  ]
    .filter(Boolean)
    .join(" ");
  const autoApproval = explicitMode === "auto" || isAutoApprovalText(approvalText);
  const manualApprovalEvent =
    requestedState === "waiting_approval" || lastHookEvent === "PermissionRequest";
  const approvalMode: ApprovalMode = autoApproval
    ? "auto"
    : explicitMode === "manual" || explicitRequired === true || manualApprovalEvent
      ? "manual"
      : explicitMode || "unknown";
  const approvalRequired =
    explicitRequired ??
    (approvalMode === "manual" && manualApprovalEvent && !autoApproval);
  const approvalRequestSummary =
    text(input.approvalRequestSummary) ||
    text(raw?.approvalRequestSummary) ||
    text(raw?.approval_request_summary) ||
    text(readPath(raw, ["permission_request", "summary"])) ||
    text(readPath(raw, ["permission_request", "reason"])) ||
    lastCommandSummary;
  const approvalRequestDetails =
    text(input.approvalRequestDetails) ||
    text(raw?.approvalRequestDetails) ||
    text(raw?.approval_request_details) ||
    text(readPath(raw, ["permission_request", "details"])) ||
    text(readPath(raw, ["permission_request", "description"])) ||
    text(readPath(raw, ["permission_request", "command"])) ||
    text(raw?.command);

  return removeUndefined({
    approvalMode,
    approvalRequired,
    approvalRequestSummary,
    approvalRequestDetails,
    approvalLastEvent:
      text(input.approvalLastEvent) ||
      text(raw?.approvalLastEvent) ||
      text(raw?.approval_last_event) ||
      lastHookEvent,
  });
}

function approvalModeValue(...values: unknown[]): ApprovalMode | undefined {
  for (const value of values) {
    const candidate = text(value)?.toLowerCase();
    if (!candidate) {
      continue;
    }

    if (["manual", "manual approval", "user"].includes(candidate)) {
      return "manual";
    }

    if (
      [
        "auto",
        "automatic",
        "auto approval",
        "auto-approval",
        "approve for me",
        "替我审批",
      ].includes(candidate)
    ) {
      return "auto";
    }

    if (candidate === "unknown") {
      return "unknown";
    }
  }

  return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }

    const candidate = text(value)?.toLowerCase();
    if (!candidate) {
      continue;
    }

    if (["true", "1", "yes", "required"].includes(candidate)) {
      return true;
    }

    if (["false", "0", "no", "not_required", "none"].includes(candidate)) {
      return false;
    }
  }

  return undefined;
}

function isAutoApprovalText(value: string): boolean {
  const normalized = value.toLowerCase();
  return [
    "auto approval",
    "auto-approval",
    "automatic approval",
    "approve for me",
    "approved automatically",
    "auto approved",
    "替我审批",
    "自动审批",
    "自动批准",
  ].some((marker) => normalized.includes(marker));
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

interface ReasonInput {
  state: AgentState;
  message?: string;
  reasonCode?: string;
  reasonMessage?: string;
  lastHookEvent?: string;
  lastCommandSummary?: string;
  approvalRequired?: boolean;
}

function reasonForStatus(input: ReasonInput): {
  reasonCode: string;
  reasonMessage: string;
} {
  const explicitCode = text(input.reasonCode);
  const explicitMessage = text(input.reasonMessage);
  if (explicitCode && explicitMessage) {
    return { reasonCode: explicitCode, reasonMessage: explicitMessage };
  }

  if (
    input.state === "waiting_approval" &&
    input.approvalRequired === true
  ) {
    return {
      reasonCode: explicitCode || "permission_request",
      reasonMessage:
        explicitMessage ||
        "Waiting for your approval",
    };
  }

  if (input.state === "running") {
    return {
      reasonCode: explicitCode || "agent_running",
      reasonMessage: explicitMessage || "Agent is running",
    };
  }

  if (input.state === "done" || input.lastHookEvent === "Stop") {
    return {
      reasonCode: explicitCode || "agent_completed",
      reasonMessage: explicitMessage || "Agent response completed",
    };
  }

  if (input.state === "stale") {
    return {
      reasonCode: explicitCode || "no_status_update_after_running",
      reasonMessage: explicitMessage || "No status update after running",
    };
  }

  if (input.state === "error") {
    if (isQuotaLimitText(input.message)) {
      return {
        reasonCode: explicitCode || "quota_or_usage_limit",
        reasonMessage: explicitMessage || "Codex quota or usage limit reached",
      };
    }

    return {
      reasonCode: explicitCode || "agent_error",
      reasonMessage: explicitMessage || text(input.message) || "Agent error",
    };
  }

  return {
    reasonCode: explicitCode || "agent_idle",
    reasonMessage: explicitMessage || "No visible sessions need attention",
  };
}

function commandSummaryFromRaw(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  const command = text(raw?.command);
  return command ? `Run: ${summarizeText(command)}` : undefined;
}

function userPromptFromRaw(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  return (
    text(raw?.prompt) ||
    text(raw?.user_prompt) ||
    text(raw?.message) ||
    text(raw?.input) ||
    text(raw?.text)
  );
}

function promptFileNameFromRaw(
  raw: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    ...fileNameCandidates(raw?.files),
    ...fileNameCandidates(raw?.attachments),
    ...fileNameCandidates(raw?.file),
    ...fileNameCandidates(raw?.path),
    ...fileNameCandidates(raw?.filename),
    ...fileNameCandidates(raw?.name),
    ...fileNameCandidates(readPath(raw, ["input", "file"])),
    ...fileNameCandidates(readPath(raw, ["input", "path"])),
    ...fileNameCandidates(raw?.prompt),
    ...fileNameCandidates(raw?.user_prompt),
    ...fileNameCandidates(raw?.message),
    ...fileNameCandidates(raw?.input),
  ];

  return candidates.find(isTextFileName);
}

function fileNameCandidates(value: unknown): string[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(fileNameCandidates);
  }

  const record = asRecord(value);
  if (record) {
    return [
      ...fileNameCandidates(record.name),
      ...fileNameCandidates(record.filename),
      ...fileNameCandidates(record.path),
      ...fileNameCandidates(record.file),
    ];
  }

  const candidate = text(value);
  if (!candidate) {
    return [];
  }

  return fileNameCandidatesFromText(candidate);
}

function fileNameCandidatesFromText(value: string): string[] {
  const candidates: string[] = [];
  const cleaned = value.replace(/^file:\/\//i, "").trim();
  const pathMatches = cleaned.matchAll(
    /\/[^\n\r"'<>]+?\.(?:md|txt|json|ya?ml|csv|tsx?|jsx?|py|docx|pdf)\b/gi,
  );

  for (const match of pathMatches) {
    candidates.push(path.basename(match[0].trim()));
  }

  const fileMatches = cleaned.matchAll(
    /(?:^|[\s"'`])([^/\s"'`<>:]+\.(?:md|txt|json|ya?ml|csv|tsx?|jsx?|py|docx|pdf))\b/gi,
  );

  for (const match of fileMatches) {
    if (match[1]) {
      candidates.push(path.basename(match[1].trim()));
    }
  }

  if (/^[^\n\r]+?\.(?:md|txt|json|ya?ml|csv|tsx?|jsx?|py|docx|pdf)$/i.test(cleaned)) {
    candidates.push(path.basename(cleaned));
  }

  return [...new Set(candidates)];
}

function isTextFileName(value: string | undefined): boolean {
  const candidate = text(value)?.toLowerCase();
  if (!candidate) {
    return false;
  }

  return [
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".csv",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".docx",
    ".pdf",
  ].some((extension) => candidate.endsWith(extension));
}

function summarizeText(value: string): string {
  return value.length > 80 ? `${value.slice(0, 79)}…` : value;
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

function hasQuotaLimitSignal(
  input:
    | Pick<StatusUpdateInput, "message" | "raw">
    | Pick<SessionStatus, "message" | "raw">,
  raw: Record<string, unknown> | undefined,
): boolean {
  const candidates = [text(input.message), ...quotaSignalStrings(raw)].filter(
    Boolean,
  );
  return candidates.some((candidate) => isQuotaLimitText(candidate));
}

function quotaSignalStrings(
  value: unknown,
  parentKey = "",
  depth = 0,
): string[] {
  if (depth > 5 || value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    return isQuotaSignalKey(parentKey) ? [value] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      quotaSignalStrings(item, parentKey, depth + 1),
    );
  }

  if (typeof value !== "object") {
    return [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => quotaSignalStrings(child, key, depth + 1),
  );
}

function isQuotaSignalKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return [
    "error",
    "errors",
    "exception",
    "message",
    "reason",
    "status",
    "stderr",
    "stdout",
    "output",
    "detail",
    "details",
    "code",
    "last_error",
    "lastError",
  ].some((signalKey) => normalized === signalKey.toLowerCase());
}

function isQuotaLimitText(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return [
    /quota.{0,40}(exceeded|exhausted|limit|used up|reached)/,
    /(exceeded|exhausted|reached).{0,40}quota/,
    /usage.{0,40}(limit|exceeded|exhausted|reached)/,
    /(limit|rate limit).{0,40}(exceeded|reached)/,
    /insufficient.{0,20}(quota|credits|balance)/,
    /out of.{0,20}(quota|credits)/,
    /额度.{0,20}(用完|耗尽|不足|达到|超出|限制)/,
    /(用完|耗尽|不足|达到|超出).{0,20}额度/,
  ].some((pattern) => pattern.test(normalized));
}

function quotaLimitMessage(message: string | undefined): string {
  const explicitMessage = text(message);
  if (explicitMessage && isQuotaLimitText(explicitMessage)) {
    return explicitMessage;
  }

  return "Codex quota or usage limit reached";
}

function displayNameFromProject(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.includes("/") ? path.basename(value) : value;
}

function makeDisplayTitle(session: SessionStatus): string {
  return (
    displayText(session.filePromptTitle) ||
    displayText(session.title) ||
    displayText(session.firstUserPromptSummary) ||
    displayText(session.sessionName) ||
    usefulShortSessionId(session.sessionId) ||
    "Untitled session"
  );
}

function summarizeTitle(value: string | undefined): string | undefined {
  const candidate = displayText(value);
  if (!candidate) {
    return undefined;
  }

  return candidate.length > 48 ? `${candidate.slice(0, 48)}...` : candidate;
}

function isDefaultSessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId?.includes("default-session"));
}

function usefulShortSessionId(sessionId: string | undefined): string | undefined {
  const candidate = displayText(sessionId);
  if (!candidate || isDefaultSessionId(candidate) || isCodexThreadId(candidate)) {
    return undefined;
  }

  return undefined;
}

function shouldRedisplay(
  next: SessionStatus,
  previous: SessionStatus | undefined,
): boolean {
  if (previous?.visibility !== "dismissed") {
    return true;
  }

  if (next.source === "system") {
    return false;
  }

  return ["waiting_approval", "error", "running", "done"].includes(next.state);
}

function pickCodexThreadId(
  input: StatusUpdateInput,
  raw: Record<string, unknown> | undefined,
): string | undefined {
  const candidates = [
    text(readPath(raw, ["session_meta", "payload", "id"])),
    text(input.codexThreadId),
    text(raw?.codexThreadId),
    text(raw?.thread_id),
    text(raw?.threadId),
    text(input.sessionId),
    text(raw?.session_id),
    text(raw?.sessionId),
    text(raw?.conversation_id),
    text(raw?.conversationId),
  ];

  return candidates.find(isCodexThreadId);
}

function pickCodexSessionId(
  input: StatusUpdateInput,
  raw: Record<string, unknown> | undefined,
): string | undefined {
  return (
    text(input.codexSessionId) ||
    text(raw?.codexSessionId) ||
    text(raw?.session_id) ||
    text(raw?.sessionId) ||
    text(raw?.thread_id) ||
    text(raw?.threadId) ||
    text(raw?.conversation_id) ||
    text(raw?.conversationId)
  );
}

function cleanCodexDeepLink(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.match(/^codex:\/\/threads\/([^/?#]+)$/i);
  const threadId = match?.[1];
  return isCodexThreadId(threadId) ? `codex://threads/${threadId}` : undefined;
}

function readPath(value: unknown, keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }

  return current;
}

async function openTarget(target: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("open", [target]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", target]);
    return;
  }

  await execFileAsync("xdg-open", [target]);
}

async function openCodexDeepLink(
  target: string,
  bundleId: string,
  appName: string,
): Promise<void> {
  if (process.platform === "darwin") {
    if (bundleId) {
      await execFileAsync("open", ["-b", bundleId, target]);
    } else {
      await openTarget(target);
    }

    await activateCodexApp(appName, bundleId);
    return;
  }

  await openTarget(target);
}

async function openCodexApp(
  appName: string,
  bundleId: string,
): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      if (bundleId) {
        await execFileAsync("open", ["-b", bundleId]);
      } else {
        await execFileAsync("open", ["-a", appName]);
      }
      await activateCodexApp(appName, bundleId);
      return true;
    }

    await openTarget(appName);
    return true;
  } catch {
    return false;
  }
}

async function activateCodexApp(
  appName: string,
  bundleId: string,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }

  const script = bundleId
    ? `tell application id "${escapeAppleScript(bundleId)}" to activate`
    : `tell application "${escapeAppleScript(appName)}" to activate`;

  try {
    await execFileAsync("osascript", ["-e", script]);
  } catch {
    // Activation is a best-effort foreground hint. Opening still counts if it succeeded.
  }
}

function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function displayText(value: unknown): string | undefined {
  const candidate = text(value);
  if (
    !candidate ||
    candidate.includes("default-session") ||
    isCodexThreadId(candidate) ||
    /^[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}$/i.test(candidate)
  ) {
    return undefined;
  }

  return candidate;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function removeUndefined<T extends object>(value: T): T {
  const next = { ...value } as Record<string, unknown>;
  for (const key of Object.keys(next)) {
    if (typeof next[key] === "undefined") {
      delete next[key];
    }
  }

  return next as T;
}
