#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const [, , stateArg, ...messageParts] = process.argv;
let state = stateArg || "idle";
let message = messageParts.join(" ") || defaultMessage(state);
const project = path.basename(process.cwd());
const logPath =
  process.env.AGENT_STATUS_LIGHT_HOOK_LOG ||
  "/Users/leoclaw/Documents/AgentLight/agent-status-light/logs/codex-hook.log";

main().catch((error) => {
  appendLog(`hook unexpected error=${error instanceof Error ? error.message : String(error)}`);
});

async function main() {
  const stdin = await readStdin();
  if (stdin.includes('"hook_event_name"') && stdin.includes('"Stop"')) {
    state = "done";
    message = "Codex finished";
  }

  const payload = {
    agent: "codex",
    state,
    source: "codex-hook",
    message,
    project
  };

  appendLog(`hook invoked state=${state} message=${JSON.stringify(message)} cwd=${process.cwd()}`);

  try {
    const body = await postStatus(payload);
    appendLog(`status updated response=${body}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendLog(`status update failed error=${message}`);
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

function postStatus(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(process.env.STATUS_LIGHT_PORT || 8787),
        path: "/status",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data)
        },
        timeout: 3000
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
    // Logging must never block Codex.
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
