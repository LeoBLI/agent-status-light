#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.env.STATUS_LIGHT_PORT || 8787);
const baseUrl = `http://127.0.0.1:${port}`;
const userHooksPath = path.join(os.homedir(), ".codex", "hooks.json");
const projectHooksPath = path.join(process.cwd(), ".codex", "hooks.json");

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  console.log("AgentWatch Diagnostics\n");

  const health = await getJson("/health").catch((error) => ({ error }));
  const status = await getJson("/status").catch((error) => ({ error }));
  const diagnostics = await getJson("/diagnostics").catch((error) => ({
    error,
  }));

  const serviceOk = Boolean(health.ok && !health.error);
  const diagnosticsOk = Boolean(diagnostics.ok && !diagnostics.error);
  const currentStatus = diagnosticsOk ? diagnostics.currentStatus : status;
  const hookHealth = diagnosticsOk ? diagnostics.hookHealth : undefined;

  console.log(`Service: ${serviceOk ? "OK" : "FAIL"}`);
  console.log(`Status endpoint: ${status.error ? "FAIL" : "OK"}`);
  console.log(`Diagnostics endpoint: ${diagnosticsOk ? "OK" : "FAIL"}`);

  if (!status.error) {
    console.log(`Status version: ${diagnostics.statusVersion || "unknown"}`);
    console.log(`Current state: ${currentStatus.state || "unknown"}`);
    if (currentStatus.source) {
      console.log(`Current source: ${currentStatus.source}`);
    }
    if (typeof currentStatus.projectCount === "number") {
      console.log(`Projects: ${currentStatus.projectCount}`);
      console.log(`Sessions: ${currentStatus.sessionCount}`);
    }
  }

  if (diagnostics.autoTransitions) {
    console.log(
      `Done auto-dismiss: ${diagnostics.stateSemantics?.doneAutoDismiss ? "yes" : "no"}`,
    );
    console.log(
      `PostToolUse marks done: ${diagnostics.stateSemantics?.postToolUseMarksDone ? "yes" : "no"}`,
    );
    console.log(
      `Stale timeout: ${diagnostics.autoTransitions.staleTimeoutMs}ms`,
    );
  }

  if (typeof diagnostics.visibleWaitingApprovalCount === "number") {
    console.log(`Approval mode: ${diagnostics.approvalMode || "unknown"}`);
    console.log(
      `Visible approvals: ${diagnostics.visibleWaitingApprovalCount}`,
    );
    console.log(
      `Manual approvals required: ${
        diagnostics.visibleApprovalRequiredCount ??
        diagnostics.manualApprovalRequiredCount ??
        0
      }`,
    );
    console.log(
      `Auto approval events: ${diagnostics.autoApprovalEventCount ?? 0}`,
    );
    console.log(
      `Dismiss all done available: ${
        diagnostics.dismissAllDoneAvailable ? "yes" : "no"
      }`,
    );
    console.log(
      `Details panel available: ${
        diagnostics.detailsPanelAvailable ? "yes" : "no"
      }`,
    );
    console.log(
      `Approve all approval available: ${
        diagnostics.approveAllApprovalAvailable ? "yes" : "no"
      }${
        diagnostics.approveActionReason
          ? ` (${diagnostics.approveActionReason})`
          : ""
      }`,
    );
    console.log(`Visible stale: ${diagnostics.visibleStaleCount}`);
    console.log(`Visible errors: ${diagnostics.visibleErrorCount}`);
    console.log(
      `Missing project path sessions: ${diagnostics.missingProjectPathSessionCount}`,
    );
  }

  if (diagnostics.codexOpenSupport) {
    console.log(`Codex app name: ${diagnostics.codexOpenSupport.appName}`);
    console.log(
      `Codex bundle id: ${diagnostics.codexOpenSupport.bundleId || "unknown"}`,
    );
    console.log(
      `Codex deeplink scheme: ${diagnostics.codexOpenSupport.deeplinkScheme}`,
    );
    console.log(
      `Codex session index: ${
        diagnostics.codexOpenSupport.sessionIndexFound ? "found" : "missing"
      }`,
    );
    console.log(
      `Thread deeplink support: ${diagnostics.codexOpenSupport.threadDeepLinkSupport}`,
    );
  }

  console.log(
    `User hooks file: ${exists(userHooksPath) ? "found" : "missing"}`,
  );
  console.log(
    `Project hooks file: ${exists(projectHooksPath) ? "found" : "missing"}`,
  );

  if (hookHealth) {
    console.log(
      `Last hook event: ${
        hookHealth.lastHookEventAt
          ? formatDate(hookHealth.lastHookEventAt)
          : "never"
      }`,
    );
    console.log(
      `Hook recently active: ${hookHealth.isHookRecentlyActive ? "yes" : "no"}`,
    );
  } else {
    console.log("Last hook event: unknown");
    console.log("Hook recently active: unknown");
  }

  console.log("\nRecommendation:");
  for (const line of recommendations(
    serviceOk,
    diagnosticsOk,
    diagnostics,
    hookHealth,
  )) {
    console.log(`- ${line}`);
  }
}

function getJson(route) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${baseUrl}${route}`,
      { timeout: 2000 },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            !response.statusCode ||
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            reject(
              new Error(
                `${route} returned HTTP ${response.statusCode}: ${body}`,
              ),
            );
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`${route} returned invalid JSON`));
          }
        });
      },
    );

    request.on("timeout", () =>
      request.destroy(new Error(`${route} timed out`)),
    );
    request.on("error", reject);
  });
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString();
}

function recommendations(serviceOk, diagnosticsOk, diagnostics, hookHealth) {
  if (!serviceOk) {
    return [
      "Start the app with npm run dev, or start only the HTTP service with npm run dev:server.",
    ];
  }

  if (!diagnosticsOk) {
    return [
      "The service is running, but /diagnostics is unavailable. Rebuild and restart the app.",
    ];
  }

  if (!["v2", "v3-hierarchical"].includes(diagnostics.statusVersion)) {
    return [
      "This service does not report a current status version. An older AgentWatch process is probably still running.",
      "Quit the floating window completely, then run npm run dev again.",
    ];
  }

  const lines = [];

  if (hookHealth?.isHookRecentlyActive) {
    lines.push("Codex hooks are actively sending events to this service.");
    lines.push(
      "For stale testing, use npm run dev:stale-test on port 8788 or stop Codex hooks temporarily.",
    );
  }

  if (hookHealth?.isHookRecentlyActive) {
    lines.push("Codex CLI hooks appear to be working.");
    lines.push(
      "If Codex Desktop does not trigger hooks, use CLI mode or enable a fallback monitor later.",
    );
    return lines;
  }

  return [
    "No recent codex-hook event was seen in the last 10 minutes.",
    'Verify with Codex CLI first, or run: echo \'{"hook_event_name":"PermissionRequest","cwd":"/tmp"}\' | node scripts/codex-hook-reporter.js waiting_approval.',
    "If Codex Desktop does not trigger hooks, this may be a Desktop surface limitation rather than a status light issue.",
  ];
}
