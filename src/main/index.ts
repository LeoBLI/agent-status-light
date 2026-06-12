import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Rectangle,
  screen,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  shell
} from "electron";
import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AgentState, AppConfig, SessionStatus, StatusTree } from "../shared/types";
import { startStatusServer, StatusStore } from "./status-server";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let isQuitting = false;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

type PanelMode = "collapsed" | "expanded";

interface PanelWindowState {
  version: number;
  mode: PanelMode;
  bounds: WindowState;
  collapsedBounds: WindowState;
  expandedBounds: WindowState;
}

const windowStateVersion = 3;
const baseDefaultWindowState: WindowState = {
  width: 240,
  height: 178
};
let panelMode: PanelMode = "collapsed";
let panelWindowState: PanelWindowState | undefined;

const config = loadConfig();
const store = new StatusStore({
  staleTimeoutMs: config.staleTimeoutMs,
  doneToIdleMs: config.doneToIdleMs,
  codexAppName: config.codexAppName,
  codexBundleId: config.codexBundleId,
  titleOverridesPath:
    process.env.SESSION_TITLE_OVERRIDES_PATH ||
    path.join(process.cwd(), "session-title-overrides.json"),
  projectNameOverridesPath:
    process.env.PROJECT_NAME_OVERRIDES_PATH ||
    path.join(process.cwd(), "project-name-overrides.json")
});
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showPanel();
  });

  app.whenReady().then(async () => {
    app.setName("AgentWatch");
    createWindow();
    createTray();
    createApplicationMenu();

    try {
      await startStatusServer(config, store);
    } catch (error) {
      handleServerStartError(error);
    }

    ipcMain.handle("status:get", () => store.getStatus());
    ipcMain.handle("statuses:get", () => store.getStatuses());
    ipcMain.handle("diagnostics:get", () => store.getDiagnostics());
    ipcMain.handle("session:dismiss", (_event, id: string) => store.dismissSession(id).tree);
    ipcMain.handle("session:mark-done", (_event, id: string) => store.markSessionDone(id));
    ipcMain.handle("done:dismiss-all", () => store.clearDone().tree);
    ipcMain.handle("approval:approve-all", () => store.approveAllApproval());
    ipcMain.handle("session:open", (_event, id: string) => store.openSession(id));
    ipcMain.on("window:hide", () => {
      savePanelWindowState();
      mainWindow?.hide();
      updateTray(store.getStatus().state);
    });
    ipcMain.handle("panel:set-mode", (_event, mode: PanelMode) => {
      setPanelMode(mode);
      return panelMode;
    });
    ipcMain.handle("panel:get-mode", () => panelMode);
    ipcMain.handle("panel:enlarge-expanded", () => {
      enlargeExpandedPanel();
      return panelMode;
    });
    ipcMain.on("window:set-expanded", (_event, expanded: boolean) => {
      setPanelMode(expanded ? "expanded" : "collapsed");
    });

    store.on("status", (tree, session, previous) => {
      mainWindow?.webContents.send("statuses:update", tree);
      mainWindow?.webContents.send("status:update", tree.overall);
      updateTray(tree.overall.state);
      handleSideEffects(tree, session, previous);
    });

    updateTray(store.getStatus().state);

    app.on("activate", () => {
      if (!mainWindow) {
        createWindow();
      }

      showPanel();
    });
  });
}

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});

function createWindow(): void {
  panelWindowState = loadPanelWindowState();
  panelMode = "collapsed";
  const windowState = panelWindowState.collapsedBounds;
  mainWindow = new BrowserWindow({
    x: windowState.x,
    y: windowState.y,
    width: windowState.width,
    height: windowState.height,
    title: "AgentWatch",
    minWidth: 220,
    minHeight: 160,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("moved", savePanelWindowState);
  mainWindow.on("resized", savePanelWindowState);

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      savePanelWindowState();
      event.preventDefault();
      mainWindow?.hide();
      updateTray(store.getStatus().state);
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function loadPanelWindowState(): PanelWindowState {
  try {
    const statePath = windowStatePath();
    if (!existsSync(statePath)) {
      return defaultPanelWindowState();
    }

    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as
      | Partial<PanelWindowState>
      | Partial<WindowState>;
    return normalizePanelWindowState(parsed);
  } catch (error) {
    console.warn("Failed to load AgentWatch window state:", error);
    return defaultPanelWindowState();
  }
}

function savePanelWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    const bounds = mainWindow.getBounds();
    const current = panelWindowState ?? defaultPanelWindowState();
    const next: PanelWindowState = {
      ...current,
      mode: panelMode,
      bounds,
      collapsedBounds:
        panelMode === "collapsed" ? bounds : current.collapsedBounds,
      expandedBounds:
        panelMode === "expanded" ? bounds : current.expandedBounds
    };
    panelWindowState = next;
    mkdirSync(path.dirname(windowStatePath()), { recursive: true });
    writeFileSync(windowStatePath(), JSON.stringify(next, null, 2));
  } catch (error) {
    console.warn("Failed to save AgentWatch window state:", error);
  }
}

function windowStatePath(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function setPanelMode(mode: PanelMode): void {
  panelMode = mode;
  const state = panelWindowState ?? defaultPanelWindowState();
  const fallbackBounds =
    mode === "expanded"
      ? defaultExpandedBounds(state.collapsedBounds)
      : defaultCollapsedBounds();
  const target = ensureWindowStateVisible(
    mode === "expanded" ? state.expandedBounds : state.collapsedBounds,
    fallbackBounds
  );

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(target);
    mainWindow.webContents.send("panel:mode", mode);
  }

  panelWindowState = {
    ...state,
    mode,
    bounds: target,
    collapsedBounds: mode === "collapsed" ? target : state.collapsedBounds,
    expandedBounds: mode === "expanded" ? target : state.expandedBounds
  };
  savePanelWindowState();
}

function enlargeExpandedPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  panelMode = "expanded";
  const current = mainWindow.getBounds();
  const workArea = screen.getDisplayMatching(current).workArea;
  const target = ensureWindowStateVisible(
    {
      x: current.x,
      y: current.y,
      width: Math.min(
        Math.round(current.width * 1.25),
        Math.round(workArea.width * 0.92)
      ),
      height: Math.min(
        Math.round(current.height * 1.35),
        Math.round(workArea.height * 0.9)
      )
    },
    current
  );

  mainWindow.setBounds(target);
  mainWindow.webContents.send("panel:mode", "expanded");

  const state = panelWindowState ?? defaultPanelWindowState();
  panelWindowState = {
    ...state,
    mode: "expanded",
    bounds: target,
    expandedBounds: target
  };
  savePanelWindowState();
}

function defaultPanelWindowState(): PanelWindowState {
  const collapsedBounds = defaultCollapsedBounds();
  const expandedBounds = defaultExpandedBounds(collapsedBounds);
  return {
    version: windowStateVersion,
    mode: "collapsed",
    bounds: collapsedBounds,
    collapsedBounds,
    expandedBounds
  };
}

function defaultCollapsedBounds(): WindowState {
  return centerWindowState({
    width: baseDefaultWindowState.width,
    height: Math.round(baseDefaultWindowState.height * 1.5)
  });
}

function defaultExpandedBounds(collapsedBounds: WindowState): WindowState {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(
    Math.round(collapsedBounds.width * 2),
    Math.round(workArea.width * 0.9)
  );
  const height = Math.min(
    Math.round(collapsedBounds.height * 2),
    Math.round(workArea.height * 0.85)
  );

  return ensureWindowStateVisible(
    {
      x: collapsedBounds.x,
      y: collapsedBounds.y,
      width,
      height
    },
    centerWindowState({ width, height })
  );
}

function normalizePanelWindowState(
  parsed: Partial<PanelWindowState> | Partial<WindowState>
): PanelWindowState {
  const legacy = parsed as Partial<WindowState>;
  const candidate = parsed as Partial<PanelWindowState>;

  if (candidate.version === windowStateVersion && candidate.collapsedBounds) {
    const collapsedBounds = ensureWindowStateVisible(
      normalizeBounds(candidate.collapsedBounds, defaultCollapsedBounds()),
      defaultCollapsedBounds()
    );
    const expandedBounds = ensureWindowStateVisible(
      normalizeBounds(
        candidate.expandedBounds,
        defaultExpandedBounds(collapsedBounds)
      ),
      defaultExpandedBounds(collapsedBounds)
    );

    return {
      version: windowStateVersion,
      mode: "collapsed",
      bounds: collapsedBounds,
      collapsedBounds,
      expandedBounds
    };
  }

  const collapsedBounds = ensureWindowStateVisible(
    normalizeBounds(
      {
        x: legacy.x,
        y: legacy.y,
        width:
          typeof legacy.width === "number"
            ? Math.round(legacy.width / 2)
            : undefined,
        height:
          typeof legacy.height === "number"
            ? Math.round(legacy.height / 3)
            : undefined
      },
      defaultCollapsedBounds()
    ),
    defaultCollapsedBounds()
  );
  const expandedBounds = defaultExpandedBounds(collapsedBounds);

  return {
    version: windowStateVersion,
    mode: "collapsed",
    bounds: collapsedBounds,
    collapsedBounds,
    expandedBounds
  };
}

function normalizeBounds(
  value: Partial<WindowState> | undefined,
  fallback: WindowState
): WindowState {
  return {
    x: typeof value?.x === "number" ? value.x : fallback.x,
    y: typeof value?.y === "number" ? value.y : fallback.y,
    width: clampDimension(value?.width, fallback.width, 220, 1600),
    height: clampDimension(value?.height, fallback.height, 160, 1400)
  };
}

function ensureWindowStateVisible(
  state: WindowState,
  fallback: WindowState
): WindowState {
  return isWindowStateVisible(state) ? state : centerWindowState(state || fallback);
}

function centerWindowState(size: Pick<WindowState, "width" | "height">): WindowState {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(display.x + (display.width - size.width) / 2),
    y: Math.round(display.y + (display.height - size.height) / 2),
    width: size.width,
    height: size.height
  };
}

function isWindowStateVisible(state: WindowState): boolean {
  if (typeof state.x !== "number" || typeof state.y !== "number") {
    return false;
  }

  const bounds: Rectangle = {
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height
  };

  return screen.getAllDisplays().some((display) => rectanglesIntersect(bounds, display.workArea));
}

function rectanglesIntersect(a: Rectangle, b: Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function clampDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function createTray(): void {
  tray = new Tray(loadTrayIcon("idle"));
  tray.setToolTip("AgentWatch · Idle");
  tray.on("click", togglePanel);
  updateTray(store.getStatus().state);
}

function togglePanel(): void {
  if (mainWindow?.isVisible()) {
    mainWindow.hide();
    updateTray(store.getStatus().state);
    return;
  }

  showPanel();
}

function showPanel(): void {
  if (!mainWindow) {
    createWindow();
  }

  if (mainWindow?.isMinimized()) {
    mainWindow.restore();
  }

  setPanelMode("collapsed");
  mainWindow?.setAlwaysOnTop(true, "floating");
  mainWindow?.show();
  mainWindow?.focus();
  updateTray(store.getStatus().state);
}

function createApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "AgentWatch",
        submenu: [
          {
            label: "Show Panel",
            click: showPanel
          },
          {
            label: "Open Diagnostics",
            click: () => {
              void shell.openExternal(`http://localhost:${config.port}/diagnostics`);
            }
          },
          { type: "separator" },
          {
            label: "Quit AgentWatch",
            accelerator: "Command+Q",
            click: () => {
              isQuitting = true;
              app.quit();
            }
          }
        ]
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" }
        ]
      }
    ])
  );
}

function updateTray(state: AgentState): void {
  if (!tray) {
    return;
  }

  try {
    const safeState = state || "idle";
    const icon = loadTrayIcon(safeState);
    if (!icon.isEmpty()) {
      tray.setImage(icon);
    }
    tray.setToolTip(`AgentWatch · ${stateLabel(safeState)}`);
    tray.setContextMenu(buildTrayMenu());
  } catch (error) {
    console.warn("Failed to update AgentWatch tray icon:", error);
  }
}

function buildTrayMenu(): Menu {
  const panelVisible = Boolean(mainWindow?.isVisible());
  const loginSettings = app.getLoginItemSettings();

  return Menu.buildFromTemplate([
    {
      label: panelVisible ? "Hide Panel" : "Show Panel",
      click: togglePanel
    },
    {
      label: "Open Diagnostics",
      click: () => {
        void shell.openExternal(`http://localhost:${config.port}/diagnostics`);
      }
    },
    {
      label: "Clear Done Sessions",
      click: () => {
        store.clearDone();
        updateTray(store.getStatus().state);
      }
    },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: loginSettings.openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      }
    },
    { type: "separator" },
    {
      label: "Quit AgentWatch",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

function trayIconPath(state: AgentState): string {
  const fileName = `tray-${trayIconName(state)}.png`;
  const candidates = [
    path.join(process.cwd(), "assets", "tray", fileName),
    path.join(app.getAppPath(), "assets", "tray", fileName),
    path.join(process.resourcesPath, "assets", "tray", fileName)
  ];

  return (
    candidates.find((candidate) => nativeImage.createFromPath(candidate).isEmpty() === false) ??
    candidates[0]
  );
}

function loadTrayIcon(state: AgentState): Electron.NativeImage {
  try {
    const icon = nativeImage.createFromPath(trayIconPath(state));
    return icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 });
  } catch {
    return nativeImage.createEmpty();
  }
}

function trayIconName(state: AgentState): string {
  switch (state) {
    case "waiting_approval":
      return "approval";
    case "running":
      return "running";
    case "done":
      return "done";
    case "error":
      return "error";
    case "stale":
      return "stale";
    case "idle":
    default:
      return "idle";
  }
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

function handleServerStartError(error: unknown): void {
  const serverError = error as NodeJS.ErrnoException;

  if (serverError.code === "EADDRINUSE") {
    store.update({
      agent: "codex",
      state: "error",
      message: `Port ${config.port} is already in use`
    });

    void dialog.showMessageBox({
      type: "warning",
      title: "AgentWatch",
      message: `Port ${config.port} is already in use.`,
      detail:
        "Another AgentWatch instance or another local service is already listening on this port. Close the existing app, or set STATUS_LIGHT_PORT / config.json to another port."
    });
    return;
  }

  store.update({
    agent: "codex",
    state: "error",
    message: "Failed to start status server"
  });

  void dialog.showErrorBox(
    "AgentWatch",
    error instanceof Error ? error.message : "Failed to start status server"
  );
}

function handleSideEffects(
  tree: StatusTree,
  session: SessionStatus,
  previous: SessionStatus | undefined
): void {
  if (
    session.state === "waiting_approval" &&
    session.approvalRequired === true &&
    previous?.state !== "waiting_approval"
  ) {
    sendApprovalNotification(session);
    maybePlaySound();
  }

  void maybeUpdateWled(tree.overall.state);
}

function sendApprovalNotification(session: SessionStatus): void {
  if (!config.enableNotifications || !Notification.isSupported()) {
    return;
  }

  new Notification({
    title: "Codex approval needed",
    body: session.message || `${session.projectName}: ${session.sessionName || session.sessionId}`
  }).show();
}

function maybePlaySound(): void {
  if (!config.enableSound) {
    return;
  }

  process.stdout.write("\u0007");
}

async function maybeUpdateWled(state: AgentState): Promise<void> {
  if (!config.enableWled || !config.wledDeviceUrl) {
    return;
  }

  const payload = toWledPayload(state);
  const url = new URL("/json/state", config.wledDeviceUrl).toString();

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.warn("Failed to update WLED device:", error);
  }
}

function toWledPayload(state: AgentState): unknown {
  switch (state) {
    case "running":
      return { on: true, bri: 180, seg: [{ col: [[0, 255, 0]], fx: 0 }] };
    case "waiting_approval":
      return { on: true, bri: 255, seg: [{ col: [[255, 0, 0]], fx: 1, sx: 200 }] };
    case "error":
      return { on: true, bri: 220, seg: [{ col: [[255, 170, 0]], fx: 0 }] };
    case "done":
      return { on: true, bri: 180, seg: [{ col: [[0, 120, 255]], fx: 0 }] };
    case "stale":
      return { on: true, bri: 120, seg: [{ col: [[150, 80, 255]], fx: 2, sx: 80 }] };
    case "idle":
    default:
      return { on: true, bri: 20, seg: [{ col: [[80, 80, 80]], fx: 0 }] };
  }
}

function loadConfig(): AppConfig {
  const fileConfig = readOptionalConfig();
  const wledDeviceUrl = process.env.WLED_DEVICE_URL || fileConfig.wledDeviceUrl;

  return {
    port: numberFromEnv("STATUS_LIGHT_PORT", fileConfig.port ?? 8787),
    codexAppName: process.env.CODEX_APP_NAME || fileConfig.codexAppName || "Codex",
    codexBundleId:
      process.env.CODEX_BUNDLE_ID || fileConfig.codexBundleId || "com.openai.codex",
    doneToIdleMs: numberFromEnv("DONE_TO_IDLE_MS", fileConfig.doneToIdleMs ?? 10 * 1000),
    staleTimeoutMs: numberFromEnv(
      "STALE_TIMEOUT_MS",
      fileConfig.staleTimeoutMs ?? 10 * 60 * 1000
    ),
    enableSound: booleanFromEnv("ENABLE_SOUND", fileConfig.enableSound ?? true),
    enableNotifications: booleanFromEnv(
      "ENABLE_NOTIFICATIONS",
      fileConfig.enableNotifications ?? true
    ),
    enableWled: booleanFromEnv("ENABLE_WLED", fileConfig.enableWled ?? Boolean(wledDeviceUrl)),
    wledDeviceUrl
  };
}

function readOptionalConfig(): Partial<AppConfig> {
  try {
    const raw = readFileSync(path.join(process.cwd(), "config.json"), "utf8");
    return JSON.parse(raw) as Partial<AppConfig>;
  } catch {
    return {};
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
