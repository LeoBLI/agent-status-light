type AgentState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "done"
  | "error"
  | "stale";
type AgentStatusSource =
  | "manual"
  | "codex-hook"
  | "codex-desktop-monitor"
  | "browser-monitor"
  | "system"
  | "unknown";
type ApprovalMode = "manual" | "auto" | "unknown";

interface SessionStatus {
  id: string;
  agent?: string;
  projectId: string;
  projectName: string;
  projectPath?: string;
  sessionId: string;
  sessionName?: string;
  title?: string;
  firstUserPromptSummary?: string;
  commandSummary?: string;
  displayTitle?: string;
  state: AgentState;
  source?: AgentStatusSource;
  message?: string;
  reasonCode?: string;
  reasonMessage?: string;
  lastHookEvent?: string;
  lastCommandSummary?: string;
  lastCwd?: string;
  projectPathExists?: boolean;
  approvalMode?: ApprovalMode;
  approvalRequired?: boolean;
  approvalRequestSummary?: string;
  approvalRequestDetails?: string;
  approvalLastEvent?: string;
  updatedAt: number;
  createdAt: number;
  visibility?: "visible" | "dismissed";
  dismissedAt?: number;
  lastCompletedAt?: number;
  lastApprovalAt?: number;
  codexThreadId?: string;
  codexSessionId?: string;
  codexSessionPath?: string;
  codexDeepLink?: string;
  openTarget?: {
    type: "codex-thread" | "codex-app" | "unknown";
    url?: string;
    appName?: string;
    fallbackReason?: string;
  };
}

interface ProjectStatus {
  projectId: string;
  projectName: string;
  projectPath?: string;
  state: AgentState;
  updatedAt: number;
  sessions: SessionStatus[];
  counts: Record<AgentState, number>;
}

interface OverallStatus {
  state: AgentState;
  updatedAt: number;
  counts: Record<AgentState, number>;
  projectCount: number;
  sessionCount: number;
  waitingApprovalCount: number;
  approvalMode: ApprovalMode;
  visibleApprovalRequiredCount: number;
  doneCount: number;
  runningCount: number;
  errorCount: number;
  staleCount: number;
}

interface StatusTree {
  overall: OverallStatus;
  projects: ProjectStatus[];
}

interface OpenSessionResult {
  ok: boolean;
  opened: boolean;
  strategy: "deeplink" | "open-app" | "failed";
  target?: string;
  fallbackUsed: boolean;
  message: string;
}

interface ApproveAllApprovalResult {
  ok: boolean;
  reasonCode?: string;
  reasonMessage?: string;
  approvedCount: number;
  failedCount: number;
  results: Array<{
    sessionId: string;
    ok: boolean;
    reasonCode?: string;
    reasonMessage?: string;
  }>;
  tree?: StatusTree;
}

const root = document.querySelector<HTMLElement>("#app");
const toggle = document.querySelector<HTMLButtonElement>("#toggle");
const hideWindow = document.querySelector<HTMLButtonElement>("#hideWindow");
const overallLight = document.querySelector<HTMLElement>("#overallLight");
const overallLabel = document.querySelector<HTMLElement>("#overallLabel");
const overallMessage = document.querySelector<HTMLElement>("#overallMessage");
const approvalModeEl = document.querySelector<HTMLElement>("#approvalMode");
const dismissAllDone = document.querySelector<HTMLButtonElement>("#dismissAllDone");
const approveAllApproval =
  document.querySelector<HTMLButtonElement>("#approveAllApproval");
const treeEl = document.querySelector<HTMLElement>("#tree");
const statusApi = (
  window as unknown as {
    agentStatus: {
      getStatuses: () => Promise<StatusTree>;
      dismissSession: (id: string) => Promise<StatusTree>;
      dismissAllDone: () => Promise<StatusTree>;
      approveAllApproval: () => Promise<ApproveAllApprovalResult>;
      openSession: (id: string) => Promise<OpenSessionResult>;
      hideWindow: () => void;
      setExpanded: (expanded: boolean) => void;
      onStatuses: (callback: (tree: StatusTree) => void) => () => void;
    };
  }
).agentStatus;

let expanded = false;
let currentTree: StatusTree | undefined;
let transientMessage: string | undefined;
let transientMessageTimer: number | undefined;
const expandedSessionIds = new Set<string>();

document.addEventListener("DOMContentLoaded", async () => {
  root?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLButtonElement) {
      return;
    }

    toggleExpanded();
  });

  toggle?.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleExpanded();
  });

  hideWindow?.addEventListener("click", (event) => {
    event.stopPropagation();
    statusApi.hideWindow();
  });

  dismissAllDone?.addEventListener("click", async (event) => {
    event.stopPropagation();
    render(await statusApi.dismissAllDone());
  });

  approveAllApproval?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const result = await statusApi.approveAllApproval();
    if (result.tree) {
      render(result.tree);
    }
    setTransientMessage(approveResultMessage(result));
  });

  statusApi.onStatuses(render);
  render(await statusApi.getStatuses());

  window.setInterval(() => {
    if (currentTree) {
      render(currentTree);
    }
  }, 1000);
});

function toggleExpanded(): void {
  expanded = !expanded;
  root?.classList.toggle("expanded", expanded);
  if (toggle) {
    toggle.textContent = expanded ? "Collapse" : "Expand";
  }
  statusApi.setExpanded(expanded);

  if (currentTree) {
    render(currentTree);
  }
}

function render(tree: StatusTree): void {
  currentTree = tree;
  document.body.dataset.state = tree.overall.state;

  if (overallLight) {
    overallLight.dataset.state = tree.overall.state;
    overallLight.setAttribute("aria-label", stateLabel(tree.overall.state));
  }

  if (overallLabel) {
    overallLabel.textContent = `Overall ${stateIcon(tree.overall.state)} ${stateLabel(
      tree.overall.state,
    )}`;
  }

  if (overallMessage) {
    overallMessage.textContent = transientMessage || summaryText(tree.overall);
  }

  if (approvalModeEl) {
    approvalModeEl.textContent = `Approval mode: ${approvalModeLabel(
      tree.overall.approvalMode,
    )}`;
  }

  updateBulkActions(tree);

  if (!treeEl) {
    return;
  }

  treeEl.textContent = "";
  const projects = expanded ? tree.projects : tree.projects.slice(0, 2);

  if (projects.length === 0) {
    treeEl.append(emptyNode());
    return;
  }

  for (const project of projects) {
    treeEl.append(projectNode(project));
    const sessions = expanded ? project.sessions : project.sessions.slice(0, 2);
    for (const session of sessions) {
      treeEl.append(sessionNode(session));
    }
  }
}

function projectNode(project: ProjectStatus): HTMLElement {
  const row = document.createElement("article");
  row.className = "row project-row";
  row.dataset.state = project.state;

  const light = document.createElement("span");
  light.className = "mini-light";
  light.dataset.state = project.state;

  const main = document.createElement("div");
  main.className = "row-main";

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = `Project: ${project.projectName}`;

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.textContent = `${stateLabel(project.state)} · ${project.sessions.length} session${project.sessions.length === 1 ? "" : "s"}`;

  main.append(title, meta);
  row.append(light, main);
  return row;
}

function sessionNode(session: SessionStatus): HTMLElement {
  const row = document.createElement("article");
  row.className = "row session-row";
  row.dataset.state = session.state;
  row.title = openTitle(session);
  row.addEventListener("click", async (event) => {
    event.stopPropagation();
    await openSession(session);
  });

  const light = document.createElement("span");
  light.className = "mini-light";
  light.dataset.state = session.state;

  const main = document.createElement("div");
  main.className = "row-main";

  const title = document.createElement("div");
  title.className = "row-title";
  title.textContent = session.displayTitle || "Untitled session";

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.textContent = sessionMeta(session);

  main.append(title, meta);

  if (expandedSessionIds.has(session.id)) {
    main.append(sessionDetails(session));
  }

  row.append(light, main);

  const open = document.createElement("button");
  open.className = "open-session";
  open.type = "button";
  open.textContent = "Open";
  open.title = openTitle(session);
  open.addEventListener("click", async (event) => {
    event.stopPropagation();
    await openSession(session, open);
  });
  row.append(open);

  const details = document.createElement("button");
  details.className = "details-toggle";
  details.type = "button";
  details.textContent = expandedSessionIds.has(session.id) ? "Hide Details" : "Details";
  details.addEventListener("click", (event) => {
    event.stopPropagation();
    if (expandedSessionIds.has(session.id)) {
      expandedSessionIds.delete(session.id);
    } else {
      expandedSessionIds.add(session.id);
    }

    if (currentTree) {
      render(currentTree);
    }
  });
  row.append(details);

  const dismiss = document.createElement("button");
  dismiss.className = "dismiss";
  dismiss.type = "button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", async (event) => {
    event.stopPropagation();
    render(await statusApi.dismissSession(session.id));
  });
  row.append(dismiss);

  return row;
}

async function openSession(
  session: SessionStatus,
  button?: HTMLButtonElement,
): Promise<void> {
  if (button) {
    button.disabled = true;
  }

  setTransientMessage("Opening Codex...");
  try {
    const result = await statusApi.openSession(session.id);
    setTransientMessage(resultMessage(result));
  } catch {
    setTransientMessage("Could not open Codex.");
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function emptyNode(): HTMLElement {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = "No sessions";
  return node;
}

function summaryText(overall: OverallStatus): string {
  const parts = [
    overall.visibleApprovalRequiredCount
      ? `${overall.visibleApprovalRequiredCount} approval`
      : "",
    overall.runningCount ? `${overall.runningCount} running` : "",
    overall.errorCount ? `${overall.errorCount} error` : "",
    overall.staleCount ? `${overall.staleCount} stale` : "",
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" · ");
  }

  return `${overall.projectCount} projects · ${overall.sessionCount} sessions`;
}

function updateBulkActions(tree: StatusTree): void {
  const doneCount = tree.overall.doneCount ?? countSessions(tree, "done");
  const approvalCount =
    tree.overall.visibleApprovalRequiredCount ??
    tree.projects.flatMap((project) => project.sessions).filter(isApprovalRequired)
      .length;

  if (dismissAllDone) {
    dismissAllDone.textContent = `Dismiss all done (${doneCount})`;
    dismissAllDone.disabled = doneCount === 0;
  }

  if (approveAllApproval) {
    approveAllApproval.textContent = `Approve all approval (${approvalCount})`;
    approveAllApproval.disabled = approvalCount === 0;
    approveAllApproval.title =
      approvalCount === 0
        ? "No manual approval sessions"
        : "Approve action is not available yet";
  }
}

function countSessions(tree: StatusTree, state: AgentState): number {
  return tree.projects
    .flatMap((project) => project.sessions)
    .filter((session) => session.state === state).length;
}

function isApprovalRequired(session: SessionStatus): boolean {
  return session.state === "waiting_approval" && session.approvalRequired === true;
}

function stateLabel(state: AgentState): string {
  switch (state) {
    case "running":
      return "Running";
    case "waiting_approval":
      return "Approval Required";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "stale":
      return "Stale";
    case "idle":
    default:
      return "Idle";
  }
}

function sessionMeta(session: SessionStatus): string {
  const duration =
    session.state === "done"
      ? formatAgo(Date.now() - (session.lastCompletedAt || session.updatedAt))
      : formatDuration(Date.now() - session.updatedAt);
  const reason = session.reasonMessage || session.message;
  return `${stateLabel(session.state)} · ${duration}${reason ? ` · ${reason}` : ""}`;
}

function sessionDetails(session: SessionStatus): HTMLElement {
  const details = document.createElement("div");
  details.className = "session-details";
  details.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const rows: Array<[string, string | undefined]> = [
    ["reasonCode", session.reasonCode],
    ["reasonMessage", session.reasonMessage],
    ["lastHookEvent", session.lastHookEvent],
    [
      "lastCommandSummary",
      session.lastCommandSummary || session.commandSummary,
    ],
    ["source", session.source],
    ["updatedAt", new Date(session.updatedAt).toLocaleString()],
    ["duration", formatDuration(Date.now() - session.updatedAt)],
    ["projectPath", session.projectPath],
    [
      "projectPathExists",
      typeof session.projectPathExists === "boolean"
        ? String(session.projectPathExists)
        : undefined,
    ],
    ["lastCwd", session.lastCwd],
    ["sessionId", session.sessionId],
    ["approvalMode", session.approvalMode],
    [
      "approvalRequired",
      typeof session.approvalRequired === "boolean"
        ? String(session.approvalRequired)
        : undefined,
    ],
    ["approvalRequestSummary", session.approvalRequestSummary],
    ["approvalRequestDetails", session.approvalRequestDetails],
    ["approvalLastEvent", session.approvalLastEvent],
  ];

  for (const [label, value] of rows) {
    if (!value) {
      continue;
    }

    const row = document.createElement("div");
    row.className = "detail-row";

    const key = document.createElement("span");
    key.className = "detail-key";
    key.textContent = label;

    const val = document.createElement("span");
    val.className = "detail-value";
    val.textContent = value;

    row.append(key, val);
    details.append(row);
  }

  return details;
}

function approvalModeLabel(mode: ApprovalMode | undefined): string {
  switch (mode) {
    case "manual":
      return "Manual approval";
    case "auto":
      return "Auto approval";
    case "unknown":
    default:
      return "Not reported";
  }
}

function approveResultMessage(result: ApproveAllApprovalResult): string {
  if (!result.ok && result.reasonCode === "approve_action_not_available") {
    return result.failedCount > 0
      ? `Approve action is not available yet (${result.failedCount} pending)`
      : "Approve action is not available yet";
  }

  return `${result.approvedCount} approved · ${result.failedCount} failed`;
}

function openTitle(session: SessionStatus): string {
  if (session.codexDeepLink) {
    return `Open Codex thread: ${session.codexDeepLink}`;
  }

  return "Open Codex app";
}

function resultMessage(result: OpenSessionResult): string {
  if (result.strategy === "deeplink" && result.opened) {
    return "Opening Codex thread...";
  }

  if (result.strategy === "open-app" && result.opened) {
    return "Opened Codex app.";
  }

  return "Could not open Codex.";
}

function setTransientMessage(message: string): void {
  transientMessage = message;

  if (transientMessageTimer) {
    window.clearTimeout(transientMessageTimer);
  }

  transientMessageTimer = window.setTimeout(() => {
    transientMessage = undefined;
    if (currentTree) {
      render(currentTree);
    }
  }, 5000);

  if (currentTree) {
    render(currentTree);
  }
}

function formatAgo(ms: number): string {
  return `${formatDuration(ms)} ago`;
}

function stateIcon(state: AgentState): string {
  switch (state) {
    case "waiting_approval":
      return "!";
    case "running":
      return ">";
    case "done":
      return "✓";
    case "error":
      return "!";
    case "stale":
      return "~";
    case "idle":
    default:
      return "•";
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));

  if (totalSeconds < 5) {
    return "just now";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
