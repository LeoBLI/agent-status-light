import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";
import path from "node:path";
import { readFileSync } from "node:fs";
import { AgentState, AppConfig, SessionStatus, StatusTree } from "../shared/types";
import { startStatusServer, StatusStore } from "./status-server";

let mainWindow: BrowserWindow | undefined;

const config = loadConfig();
const store = new StatusStore({
  staleTimeoutMs: config.staleTimeoutMs,
  doneToIdleMs: config.doneToIdleMs,
  titleOverridesPath:
    process.env.SESSION_TITLE_OVERRIDES_PATH ||
    path.join(process.cwd(), "session-title-overrides.json")
});
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    createWindow();

    try {
      await startStatusServer(config, store);
    } catch (error) {
      handleServerStartError(error);
    }

    ipcMain.handle("status:get", () => store.getStatus());
    ipcMain.handle("statuses:get", () => store.getStatuses());
    ipcMain.handle("diagnostics:get", () => store.getDiagnostics());
    ipcMain.handle("session:dismiss", (_event, id: string) => store.dismissSession(id).tree);
    ipcMain.on("window:set-expanded", (_event, expanded: boolean) => {
      mainWindow?.setSize(360, expanded ? 520 : 260);
    });

    store.on("status", (tree, session, previous) => {
      mainWindow?.webContents.send("statuses:update", tree);
      mainWindow?.webContents.send("status:update", tree.overall);
      handleSideEffects(tree, session, previous);
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 220,
    height: 260,
    minWidth: 280,
    minHeight: 76,
    maxWidth: 520,
    maxHeight: 680,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "floating");
  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
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
      title: "Agent Status Light",
      message: `Port ${config.port} is already in use.`,
      detail:
        "Another Agent Status Light instance or another local service is already listening on this port. Close the existing app, or set STATUS_LIGHT_PORT / config.json to another port."
    });
    return;
  }

  store.update({
    agent: "codex",
    state: "error",
    message: "Failed to start status server"
  });

  void dialog.showErrorBox(
    "Agent Status Light",
    error instanceof Error ? error.message : "Failed to start status server"
  );
}

function handleSideEffects(
  tree: StatusTree,
  session: SessionStatus,
  previous: SessionStatus | undefined
): void {
  if (session.state === "waiting_approval" && previous?.state !== "waiting_approval") {
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
