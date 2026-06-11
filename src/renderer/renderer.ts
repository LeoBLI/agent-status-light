type AgentState = "idle" | "running" | "waiting_approval" | "done" | "error" | "stale";
type AgentStatusSource =
  | "manual"
  | "codex-hook"
  | "codex-desktop-monitor"
  | "browser-monitor"
  | "system"
  | "unknown";

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

const root = document.querySelector<HTMLElement>("#app");
const toggle = document.querySelector<HTMLButtonElement>("#toggle");
const hideWindow = document.querySelector<HTMLButtonElement>("#hideWindow");
const overallLight = document.querySelector<HTMLElement>("#overallLight");
const overallLabel = document.querySelector<HTMLElement>("#overallLabel");
const overallMessage = document.querySelector<HTMLElement>("#overallMessage");
const treeEl = document.querySelector<HTMLElement>("#tree");
const statusApi = (window as unknown as {
  agentStatus: {
    getStatuses: () => Promise<StatusTree>;
    dismissSession: (id: string) => Promise<StatusTree>;
    openSession: (id: string) => Promise<OpenSessionResult>;
    hideWindow: () => void;
    setExpanded: (expanded: boolean) => void;
    onStatuses: (callback: (tree: StatusTree) => void) => () => void;
  };
}).agentStatus;

let expanded = false;
let currentTree: StatusTree | undefined;
let transientMessage: string | undefined;
let transientMessageTimer: number | undefined;

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
      tree.overall.state
    )}`;
  }

  if (overallMessage) {
    overallMessage.textContent = transientMessage || summaryText(tree.overall);
  }

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

async function openSession(session: SessionStatus, button?: HTMLButtonElement): Promise<void> {
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
    overall.waitingApprovalCount ? `${overall.waitingApprovalCount} approval` : "",
    overall.runningCount ? `${overall.runningCount} running` : "",
    overall.errorCount ? `${overall.errorCount} error` : "",
    overall.staleCount ? `${overall.staleCount} stale` : ""
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" · ");
  }

  return `${overall.projectCount} projects · ${overall.sessionCount} sessions`;
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
  if (session.state === "done") {
    return `Done · ${formatAgo(Date.now() - (session.lastCompletedAt || session.updatedAt))}`;
  }

  return `${stateLabel(session.state)} · ${formatDuration(Date.now() - session.updatedAt)}${
    session.message ? ` · ${session.message}` : ""
  }`;
}

function openTitle(session: SessionStatus): string {
  if (session.codexDeepLink) {
    return `Open Codex thread: ${session.codexDeepLink}`;
  }

  return "Open Codex app and copy session info";
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
