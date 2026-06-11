#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const [, , stateArg, ...messageParts] = process.argv;
const state = stateArg || "idle";
const message = messageParts.join(" ") || defaultMessage(state);
const port = Number(process.env.STATUS_LIGHT_PORT || 8787);
const logPath =
  process.env.AGENT_STATUS_LIGHT_HOOK_LOG ||
  "/Users/leoclaw/Documents/AgentLight/agent-status-light/logs/codex-hook.log";

main().catch((error) => {
  appendLog(`reporter unexpected error=${error instanceof Error ? error.message : String(error)}`);
});

async function main() {
  const stdin = await readStdin();
  const parsed = parseJson(stdin);
  const cwd = typeof parsed?.cwd === "string" ? parsed.cwd : process.cwd();
  if (isIgnoredProjectPath(cwd)) {
    appendLog(`ignored hook cwd=${cwd}`);
    return;
  }

  const hookEventName = text(parsed?.hook_event_name);
  const codexSessionId = extractCodexSessionId(parsed);
  const codexThreadId = extractCodexThreadId(parsed);
  const projectPath = cwd;
  const projectName = path.basename(cwd) || "Unknown Project";
  const sessionId =
    text(parsed?.session_id) ||
    text(parsed?.sessionId) ||
    text(parsed?.thread_id) ||
    text(parsed?.threadId) ||
    text(parsed?.conversation_id) ||
    text(parsed?.conversationId) ||
    (cwd ? `${cwd}::default-session` : "codex-default-session");
  const promptText = extractUserPromptText(
    text(parsed?.prompt) ||
      text(parsed?.user_prompt) ||
      text(parsed?.message) ||
      text(parsed?.input)
  );
  const promptSummary = summarizeText(promptText);
  const commandSummary = commandText(parsed) ? `Run: ${summarizeText(commandText(parsed))}` : undefined;
  const title =
    text(parsed?.title) || (hookEventName === "UserPromptSubmit" ? promptSummary : undefined);
  const payload = {
    agent: "codex",
    projectPath,
    project: projectName,
    projectName,
    sessionId,
    sessionName: text(parsed?.sessionName) || title,
    title,
    firstUserPromptSummary: promptSummary,
    commandSummary,
    state,
    source: "codex-hook",
    message,
    codexSessionId,
    codexThreadId,
    codexDeepLink: codexThreadId ? `codex://threads/${codexThreadId}` : undefined,
    raw: summarizeHookPayload(parsed, stdin)
  };

  appendLog(
    `hook invoked state=${state} source=codex-hook message=${JSON.stringify(message)} cwd=${cwd}`
  );

  try {
    const body = await postStatus(payload);
    appendLog(`status updated response=${body}`);
  } catch (error) {
    appendLog(`status update failed error=${error instanceof Error ? error.message : String(error)}`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));

    if (process.stdin.isTTY) {
      resolve("");
    }
  });
}

function parseJson(raw) {
  if (!raw.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch {
    appendLog("hook stdin was not valid JSON");
    return undefined;
  }
}

function summarizeHookPayload(parsed, raw) {
  if (!parsed || typeof parsed !== "object") {
    return raw.trim() ? { parseError: true, stdinPreview: raw.slice(0, 500) } : undefined;
  }

  return {
    hook_event_name: parsed.hook_event_name,
    cwd: parsed.cwd,
    session_id: parsed.session_id,
    sessionId: parsed.sessionId,
    thread_id: parsed.thread_id,
    threadId: parsed.threadId,
    conversation_id: parsed.conversation_id,
    conversationId: parsed.conversationId,
    session_meta_payload_id: readPath(parsed, ["session_meta", "payload", "id"]),
    tool_name: parsed.tool_name,
    command: parsed.command,
    permission_request: parsed.permission_request ? true : undefined
  };
}

function extractCodexThreadId(parsed) {
  const candidates = [
    text(readPath(parsed, ["session_meta", "payload", "id"])),
    text(parsed?.thread_id),
    text(parsed?.threadId),
    text(parsed?.session_id),
    text(parsed?.sessionId),
    text(parsed?.conversation_id),
    text(parsed?.conversationId)
  ];

  return candidates.find(isUuid);
}

function extractCodexSessionId(parsed) {
  return (
    text(parsed?.session_id) ||
    text(parsed?.sessionId) ||
    text(parsed?.thread_id) ||
    text(parsed?.threadId) ||
    text(parsed?.conversation_id) ||
    text(parsed?.conversationId)
  );
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function readPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function commandText(parsed) {
  return text(parsed?.command) || text(parsed?.tool_input?.command) || text(parsed?.input?.command);
}

function isIgnoredProjectPath(cwd) {
  const candidate = text(cwd);
  if (!candidate) {
    return false;
  }

  return ignoredPathPrefixes().some(
    (prefix) => candidate === prefix || candidate.startsWith(`${prefix}${path.sep}`)
  );
}

function ignoredPathPrefixes() {
  const configured = text(process.env.AGENT_STATUS_LIGHT_IGNORE_PATHS);
  if (configured) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return [path.join(os.homedir(), ".codex", "memories")];
}

function summarizeText(value) {
  const candidate = text(value);
  if (!candidate) {
    return undefined;
  }

  return candidate.length > 48 ? `${candidate.slice(0, 48)}…` : candidate;
}

function extractUserPromptText(value) {
  const candidate = text(value);
  if (!candidate) {
    return undefined;
  }

  const requestMarker = /(?:^|\n)##\s*My request for Codex:\s*/i;
  const requestMatch = candidate.match(requestMarker);
  if (requestMatch && typeof requestMatch.index === "number") {
    return cleanPromptText(candidate.slice(requestMatch.index + requestMatch[0].length));
  }

  return cleanPromptText(candidate);
}

function cleanPromptText(value) {
  return value
    .replace(/<image\b[\s\S]*?<\/image>/gi, "")
    .replace(/^#\s*Files mentioned by the user:[\s\S]*?(?=\n\S)/i, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

function postStatus(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/status",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        },
        timeout: 1500
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
            resolve(responseBody);
          } else {
            reject(new Error(`HTTP ${response.statusCode}: ${responseBody}`));
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Timed out connecting to Agent Status Light"));
    });
    request.on("error", reject);
    request.end(data);
  });
}

function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Hook logging must never block Codex.
  }
}

function defaultMessage(nextState) {
  switch (nextState) {
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
