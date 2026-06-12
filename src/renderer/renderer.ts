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
type PanelMode = "collapsed" | "expanded";

interface SessionStatus {
  id: string;
  agent?: string;
  projectId: string;
  projectName: string;
  projectPath?: string;
  sessionId: string;
  sessionName?: string;
  title?: string;
  filePromptTitle?: string;
  lastUserPrompt?: string;
  firstUserPromptSummary?: string;
  lastUserPromptAt?: number;
  promptInputType?: "text" | "file";
  promptFileName?: string;
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
const scrollMore = document.querySelector<HTMLElement>("#scrollMore");
const statusApi = (
  window as unknown as {
    agentStatus: {
      getStatuses: () => Promise<StatusTree>;
      dismissSession: (id: string) => Promise<StatusTree>;
      markSessionDone: (id: string) => Promise<{ ok: boolean; tree: StatusTree }>;
      dismissAllDone: () => Promise<StatusTree>;
      approveAllApproval: () => Promise<ApproveAllApprovalResult>;
      openSession: (id: string) => Promise<OpenSessionResult>;
      hideWindow: () => void;
      setPanelMode: (mode: PanelMode) => Promise<PanelMode>;
      getPanelMode: () => Promise<PanelMode>;
      enlargeExpandedPanel: () => Promise<PanelMode>;
      setExpanded: (expanded: boolean) => Promise<PanelMode>;
      onStatuses: (callback: (tree: StatusTree) => void) => () => void;
      onPanelMode: (callback: (mode: PanelMode) => void) => () => void;
    };
  }
).agentStatus;

let expanded = false;
let currentTree: StatusTree | undefined;
let transientMessage: string | undefined;
let transientMessageTimer: number | undefined;
const expandedSessionIds = new Set<string>();
const advancedDetailsSessionIds = new Set<string>();

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

  treeEl?.addEventListener("scroll", updateScrollIndicator);
  scrollMore?.addEventListener("click", (event) => {
    event.stopPropagation();
    void handleScrollMoreClick();
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
  statusApi.onPanelMode(applyPanelMode);
  applyPanelMode(await statusApi.getPanelMode());
  await refreshStatuses();

  window.addEventListener("focus", () => {
    void refreshStatuses();
  });
});

async function refreshStatuses(): Promise<void> {
  render(await statusApi.getStatuses());
}

async function toggleExpanded(): Promise<void> {
  await setPanelMode(expanded ? "collapsed" : "expanded");
}

async function setPanelMode(mode: PanelMode): Promise<void> {
  applyPanelMode(await statusApi.setPanelMode(mode));

  if (currentTree) {
    render(currentTree);
  }
}

function applyPanelMode(mode: PanelMode): void {
  expanded = mode === "expanded";
  root?.classList.toggle("expanded", expanded);
  root?.classList.toggle("collapsed", !expanded);
  if (toggle) {
    toggle.textContent = expanded ? "Collapse" : "Expand";
  }
  queueScrollIndicatorUpdate();
}

function render(tree: StatusTree): void {
  currentTree = tree;
  document.body.dataset.state = tree.overall.state;
  root?.classList.toggle("expanded", expanded);
  root?.classList.toggle("collapsed", !expanded);

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

  const previousTreeScrollTop = treeEl.scrollTop;
  treeEl.textContent = "";
  const sortedProjects = sortProjects(tree.projects);
  const projects = expanded ? sortedProjects : sortedProjects.slice(0, 5);

  if (projects.length === 0) {
    treeEl.append(emptyNode());
    queueScrollIndicatorUpdate();
    return;
  }

  for (const project of projects) {
    treeEl.append(projectNode(project));
    if (expanded) {
      for (const session of sortSessions(project.sessions)) {
        treeEl.append(sessionNode(session));
      }
    }
  }

  if (!expanded && sortedProjects.length > projects.length) {
    treeEl.append(moreProjectsNode(sortedProjects.length - projects.length));
  }

  treeEl.scrollTop = Math.min(previousTreeScrollTop, treeEl.scrollHeight);
  queueScrollIndicatorUpdate();
}

function queueScrollIndicatorUpdate(): void {
  window.requestAnimationFrame(updateScrollIndicator);
}

function updateScrollIndicator(): void {
  if (!treeEl || !root || !scrollMore) {
    return;
  }

  const canScroll = treeEl.scrollHeight > treeEl.clientHeight + 2;
  const atBottom =
    treeEl.scrollTop + treeEl.clientHeight >= treeEl.scrollHeight - 2;
  const show = canScroll && !atBottom;

  root.classList.toggle("has-scroll-more", show);
  root.classList.toggle("at-scroll-end", canScroll && atBottom);
  scrollMore.hidden = !show;
}

async function handleScrollMoreClick(): Promise<void> {
  if (!treeEl) {
    return;
  }

  if (!expanded) {
    await setPanelMode("expanded");
    return;
  }

  applyPanelMode(await statusApi.enlargeExpandedPanel());
  queueScrollIndicatorUpdate();
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
  title.textContent = expanded ? `Project: ${project.projectName}` : project.projectName;

  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.textContent = projectMeta(project);

  main.append(title, meta);
  row.append(light, main);
  return row;
}

function moreProjectsNode(count: number): HTMLElement {
  const node = document.createElement("div");
  node.className = "more-projects";
  node.textContent = `+ ${count} more projects`;
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    void setPanelMode("expanded");
  });
  return node;
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

  const open = document.createElement("button");
  open.className = "open-session";
  open.type = "button";
  open.textContent = "Open";
  open.title = openTitle(session);
  open.addEventListener("click", async (event) => {
    event.stopPropagation();
    await openSession(session, open);
  });

  const actions = document.createElement("div");
  actions.className = "session-row-actions";
  actions.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  actions.append(open, ...sessionActionButtons(session));

  row.append(light, main, actions);
  if (expandedSessionIds.has(session.id)) {
    row.append(sessionDetails(session));
  }

  return row;
}

function sessionActionButtons(session: SessionStatus): HTMLButtonElement[] {
  const dismiss = actionButton("Dismiss", async () => {
    expandedSessionIds.delete(session.id);
    advancedDetailsSessionIds.delete(session.id);
    render(await statusApi.dismissSession(session.id));
  });
  dismiss.className = "dismiss";

  const details = actionButton(
    expandedSessionIds.has(session.id) ? "Hide Details" : "Details",
    () => {
      toggleDetails(session.id);
    },
  );
  details.className = "details-toggle";

  return [dismiss, details];
}

function toggleDetails(sessionId: string): void {
  if (expandedSessionIds.has(sessionId)) {
    expandedSessionIds.delete(sessionId);
    advancedDetailsSessionIds.delete(sessionId);
  } else {
    expandedSessionIds.add(sessionId);
  }

  if (currentTree) {
    render(currentTree);
  }
}

function actionButton(label: string, onClick: () => void | Promise<void>): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void onClick();
  });
  return button;
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

function projectMeta(project: ProjectStatus): string {
  const counts = countsSummary(project.counts);
  if (!expanded) {
    return counts || stateLabel(project.state);
  }

  return `${stateLabel(project.state)}${counts ? ` · ${counts}` : ""}`;
}

function countsSummary(counts: Record<AgentState, number>): string {
  return stateOrder()
    .map((state) => [state, counts[state]] as const)
    .filter(([, count]) => count > 0)
    .map(([state, count]) => `${count} ${countLabel(state, count)}`)
    .join(" · ");
}

function countLabel(state: AgentState, count: number): string {
  const label =
    state === "waiting_approval" ? "approval" : state.replace("_", " ");
  return count === 1 ? label : `${label}s`;
}

function sortProjects(projects: ProjectStatus[]): ProjectStatus[] {
  return [...projects].sort((a, b) => compareStateThenUpdatedAt(a, b));
}

function sortSessions(sessions: SessionStatus[]): SessionStatus[] {
  return [...sessions].sort((a, b) => compareStateThenUpdatedAt(a, b));
}

function compareStateThenUpdatedAt(
  a: { state: AgentState; updatedAt: number },
  b: { state: AgentState; updatedAt: number },
): number {
  const stateDelta = statePriority(a.state) - statePriority(b.state);
  return stateDelta || b.updatedAt - a.updatedAt;
}

function statePriority(state: AgentState): number {
  return stateOrder().indexOf(state);
}

function stateOrder(): AgentState[] {
  return ["waiting_approval", "error", "stale", "running", "done", "idle"];
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
  details.dataset.sessionId = session.id;
  details.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const rows: Array<[string, string]> = [];
  const reason = statusReason(session);
  const approval = approvalRequest(session);

  if (reason) {
    rows.push(["Status reason", reason]);
  }

  rows.push(
    ["Prompt", detailText(promptText(session))],
    ["Current activity", detailText(currentActivity(session))],
  );

  if (approval) {
    rows.push(["Approval request", approval]);
  }

  rows.push(
    ["Working directory", detailText(session.lastCwd || session.projectPath)],
    ["Last updated", formatClock(session.updatedAt)],
  );

  for (const [label, value] of rows) {
    details.append(detailRow(label, value));
  }

  const advancedToggle = document.createElement("button");
  advancedToggle.className = "advanced-toggle";
  advancedToggle.type = "button";
  advancedToggle.textContent = "Advanced";
  advancedToggle.setAttribute(
    "aria-expanded",
    advancedDetailsSessionIds.has(session.id) ? "true" : "false",
  );
  advancedToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (advancedDetailsSessionIds.has(session.id)) {
      advancedDetailsSessionIds.delete(session.id);
    } else {
      advancedDetailsSessionIds.add(session.id);
    }

    if (currentTree) {
      render(currentTree);
    }
  });
  details.append(advancedToggle);

  if (advancedDetailsSessionIds.has(session.id)) {
    const advancedRows: Array<[string, string]> = [
      ["Last hook event", detailText(session.lastHookEvent)],
      ["Reason code", detailText(session.reasonCode)],
      ["Source", detailText(session.source)],
      ["Duration", formatDuration(Date.now() - session.updatedAt)],
      ["Project path", detailText(session.projectPath)],
      ["Project path exists", booleanText(session.projectPathExists)],
      ["Last CWD", detailText(session.lastCwd)],
      ["Session ID", detailText(session.sessionId)],
      ["Approval mode", approvalModeDetailLabel(session.approvalMode)],
      ["Approval required", booleanText(session.approvalRequired)],
      ["Approval details", detailText(session.approvalRequestDetails)],
      ["Last approval event", detailText(session.approvalLastEvent)],
      ["Last tool command", detailText(session.lastCommandSummary || session.commandSummary)],
    ];

    const advanced = document.createElement("div");
    advanced.className = "advanced-details";

    for (const [label, value] of advancedRows) {
      advanced.append(detailRow(label, value));
    }

    details.append(advanced);
  }

  return details;
}

function promptText(session: SessionStatus): string | undefined {
  return (
    session.filePromptTitle ||
    session.lastUserPrompt ||
    session.firstUserPromptSummary ||
    session.title ||
    session.sessionName
  );
}

function currentActivity(session: SessionStatus): string | undefined {
  return (
    session.lastCommandSummary ||
    session.commandSummary ||
    usefulReason(session.reasonMessage)
  );
}

function statusReason(session: SessionStatus): string | undefined {
  if (session.state === "running" || session.state === "idle") {
    return undefined;
  }

  return usefulReason(session.reasonMessage);
}

function usefulReason(value: string | undefined): string | undefined {
  if (!value || value === "-" || value === "Agent is running" || value === "Idle") {
    return undefined;
  }

  return value;
}

function approvalRequest(session: SessionStatus): string | undefined {
  if (!isApprovalContext(session)) {
    return undefined;
  }

  return (
    session.approvalRequestSummary ||
    session.approvalRequestDetails ||
    session.lastCommandSummary ||
    session.commandSummary
  );
}

function isApprovalContext(session: SessionStatus): boolean {
  return (
    session.state === "waiting_approval" ||
    session.approvalRequired === true ||
    session.lastHookEvent === "PermissionRequest"
  );
}

function detailRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "detail-row";

  const key = document.createElement("span");
  key.className = "detail-key";
  key.textContent = label;

  const val = document.createElement("span");
  val.className = "detail-value";
  if (label === "Prompt") {
    val.classList.add("detail-value-prompt");
  }
  val.textContent = value;

  row.append(key, val);
  return row;
}

function detailText(value: string | undefined): string {
  return value || "-";
}

function booleanText(value: boolean | undefined): string {
  if (typeof value !== "boolean") {
    return "-";
  }

  return value ? "Yes" : "No";
}

function approvalModeDetailLabel(mode: ApprovalMode | undefined): string {
  switch (mode) {
    case "manual":
      return "Manual approval";
    case "auto":
      return "Auto approval";
    case "unknown":
    default:
      return "Not reported by hooks";
  }
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
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
