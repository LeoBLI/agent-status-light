export type AgentState = "idle" | "running" | "waiting_approval" | "done" | "error" | "stale";

export type AgentStatusSource =
  | "manual"
  | "codex-hook"
  | "codex-desktop-monitor"
  | "browser-monitor"
  | "system"
  | "unknown";

export type CodexOpenTargetType = "codex-thread" | "codex-app" | "unknown";

export interface CodexOpenTarget {
  type: CodexOpenTargetType;
  url?: string;
  appName?: string;
  fallbackReason?: string;
}

export type SessionVisibility = "visible" | "dismissed";

export interface SessionStatus {
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
  visibility?: SessionVisibility;
  dismissedAt?: number;
  lastCompletedAt?: number;
  lastApprovalAt?: number;
  codexThreadId?: string;
  codexSessionId?: string;
  codexSessionPath?: string;
  codexDeepLink?: string;
  openTarget?: CodexOpenTarget;
  raw?: unknown;
}

export interface ProjectStatus {
  projectId: string;
  projectName: string;
  projectPath?: string;
  state: AgentState;
  updatedAt: number;
  sessions: SessionStatus[];
  counts: Record<AgentState, number>;
}

export interface OverallStatus {
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

export interface StatusTree {
  overall: OverallStatus;
  projects: ProjectStatus[];
}

export interface OpenSessionResult {
  ok: boolean;
  opened: boolean;
  strategy: "deeplink" | "open-app" | "failed";
  target?: string;
  fallbackUsed: boolean;
  message: string;
}

export interface StatusUpdateInput {
  agent?: string;
  project?: string;
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  sessionId?: string;
  sessionName?: string;
  taskId?: string;
  title?: string;
  firstUserPromptSummary?: string;
  commandSummary?: string;
  state?: AgentState;
  source?: AgentStatusSource;
  message?: string;
  codexThreadId?: string;
  codexSessionId?: string;
  codexSessionPath?: string;
  codexDeepLink?: string;
  raw?: unknown;
}

export interface HookHealth {
  lastHookEventAt?: number;
  lastHookState?: AgentState;
  isHookRecentlyActive: boolean;
}

export interface Diagnostics {
  ok: true;
  serviceName: "AgentWatch";
  statusVersion: "v3-hierarchical";
  currentStatus: OverallStatus;
  hookHealth: HookHealth;
  eventsCount: number;
  autoTransitions: {
    doneDisplayMs: number;
    staleTimeoutMs: number;
  };
  codexOpenSupport: {
    appName: string;
    bundleId: string;
    deeplinkScheme: "codex://";
    sessionIndexFound: boolean;
    sessionIndexPath: string;
    threadDeepLinkSupport: "best-effort";
  };
}

export interface AppConfig {
  port: number;
  codexAppName: string;
  codexBundleId: string;
  staleTimeoutMs: number;
  doneToIdleMs: number;
  enableSound: boolean;
  enableNotifications: boolean;
  enableWled: boolean;
  wledDeviceUrl?: string;
}

export const VALID_STATES: AgentState[] = [
  "idle",
  "running",
  "waiting_approval",
  "done",
  "error",
  "stale"
];

export const VALID_SOURCES: AgentStatusSource[] = [
  "manual",
  "codex-hook",
  "codex-desktop-monitor",
  "browser-monitor",
  "system",
  "unknown"
];

export const STATE_PRIORITY: Record<AgentState, number> = {
  waiting_approval: 5,
  error: 4,
  stale: 3,
  running: 2,
  done: 1,
  idle: 0
};

export function emptyCounts(): Record<AgentState, number> {
  return {
    idle: 0,
    running: 0,
    waiting_approval: 0,
    done: 0,
    error: 0,
    stale: 0
  };
}
