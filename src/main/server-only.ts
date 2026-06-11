import { startStatusServer, StatusStore } from "./status-server";
import path from "node:path";

const port = Number(process.env.STATUS_LIGHT_PORT || 8787);
const staleTimeoutMs = Number(process.env.STALE_TIMEOUT_MS || 10 * 60 * 1000);
const doneToIdleMs = Number(process.env.DONE_TO_IDLE_MS || 10 * 1000);
const codexAppName = process.env.CODEX_APP_NAME || "Codex";
const codexBundleId = process.env.CODEX_BUNDLE_ID || "com.openai.codex";
const titleOverridesPath =
  process.env.SESSION_TITLE_OVERRIDES_PATH ||
  path.join(process.cwd(), "session-title-overrides.json");
const projectNameOverridesPath =
  process.env.PROJECT_NAME_OVERRIDES_PATH ||
  path.join(process.cwd(), "project-name-overrides.json");
const store = new StatusStore({
  staleTimeoutMs,
  doneToIdleMs,
  codexAppName,
  codexBundleId,
  titleOverridesPath,
  projectNameOverridesPath
});

void startStatusServer(
  {
    port,
    codexAppName,
    codexBundleId,
    staleTimeoutMs,
    doneToIdleMs,
    enableSound: false,
    enableNotifications: false,
    enableWled: false
  },
  store
).catch((error) => {
  const serverError = error as NodeJS.ErrnoException;

  if (serverError.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the existing app or set STATUS_LIGHT_PORT.`);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});

store.on("status", (tree, session) => {
  console.log(JSON.stringify({ session, overall: tree.overall }));
});
