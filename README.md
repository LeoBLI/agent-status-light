# AgentWatch

Keep an eye on your agents.

AgentWatch is a desktop companion that watches your AI agent sessions, alerts you when they need attention, and helps you return to the right task.

Status: v0.3.7 — UI Regression Fix.

```text
Signal Sources
  - manual
  - codex-hook
  - future: codex-desktop-monitor
  - future: browser-monitor
        ↓
Unified status service
        ↓
Electron floating panel + macOS menu bar icon
```

## Features

- Local HTTP status service with `GET /status`, `POST /status`, `GET /events`, and `GET /diagnostics`.
- macOS menu bar status icon with show/hide controls.
- Frameless, always-on-top floating panel.
- Resizable floating panel with remembered window size and position.
- Status v2 display: gray `idle`, green `running`, flashing red `waiting_approval`, blue/cyan `done`, orange `error`, purple slow-flashing `stale`.
- Click the window to expand or collapse status and hook-health details.
- Open a visible session in Codex with best-effort `codex://` deeplink support and app fallback.
- Desktop notification and terminal bell when approval is needed.
- Optional WLED/ESP32 HTTP integration.

## Install

```bash
cd /Users/leoclaw/Projects/AgentWatch
npm install
```

## Start

```bash
npm run dev
```

The app starts the Electron floating window and the local service:

```text
http://localhost:8787
```

For HTTP-only troubleshooting without opening the Electron window:

```bash
npm run dev:server
```

## AgentWatch v0.3: macOS Menu Bar App

AgentWatch v0.3 moves the tool from a CLI-launched floating utility toward a resident macOS companion app.

The menu bar icon mirrors the overall state:

- Gray: `idle`
- Green: `running`
- Red: `waiting_approval`
- Blue/cyan: `done`
- Orange: `error`
- Purple: `stale`

Click the menu bar icon to show or hide the AgentWatch panel. The panel remains always-on-top and draggable. Closing or hiding the panel does not quit AgentWatch; the local HTTP service keeps running, so Codex hooks can still post to `http://localhost:8787`.

The panel supports manual resizing. AgentWatch remembers the last window size and position in Electron's app data directory as `window-state.json`, and falls back to a default on-screen position if the saved bounds are no longer visible.

Collapsed mode shows only the overall status and project rows in a compact scrollable overview. Expanded mode shows project rows, session rows, direct `Open` / `Dismiss` / `Details` actions, and Details when opened. Long lists scroll inside the panel and show a subtle `↓ More` indicator while additional rows are below the visible area.

Use the tray right-click menu for:

- `Show Panel` / `Hide Panel`
- `Open Diagnostics`
- `Clear Done Sessions`
- `Launch at Login`
- `Quit AgentWatch`

`Launch at Login` uses Electron login item settings. It should be verified from a packaged app because development mode runs through the Electron development wrapper.

Build a local macOS app:

```bash
npm run pack
```

Create distributable macOS artifacts:

```bash
npm run dist
```

The first packaged app is created under `release/mac/AgentWatch.app`. Move it to `/Applications` for local use. This project does not currently include Apple Developer signing, notarization, automatic updates, or Mac App Store packaging.

## Test Manually

Keep `npm run dev` running in one Terminal window. Run the test commands below in a second Terminal window or tab.

Set approval-needed state:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"waiting_approval","source":"manual","message":"Codex needs approval"}'
```

Set running state:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"running","source":"manual","message":"Codex is running"}'
```

Set idle state:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"idle","source":"manual","message":"Codex is idle"}'
```

Read current state:

```bash
curl -s http://localhost:8787/status
```

Read recent status events and diagnostics:

```bash
curl -s http://localhost:8787/events
curl -s http://localhost:8787/diagnostics
```

You can also use the shorter npm helpers from a second Terminal:

```bash
npm run status:approval
npm run status:running
npm run status:idle
```

Run the diagnostic script:

```bash
node scripts/diagnose.js
```

## HTTP API

### `POST /status`

```json
{
  "agent": "codex",
  "state": "waiting_approval",
  "source": "manual",
  "message": "Codex needs approval",
  "project": "optional project name",
  "codexThreadId": "optional Codex thread id",
  "codexSessionId": "optional Codex session id"
}
```

If `source` is omitted, the server treats the update as `manual`.

Supported sources:

- `manual`
- `codex-hook`
- `codex-desktop-monitor`
- `browser-monitor`
- `system`
- `unknown`

Supported states:

- `idle`
- `running`
- `waiting_approval`
- `done`
- `error`
- `stale`

### `GET /status`

```json
{
  "agent": "codex",
  "state": "waiting_approval",
  "source": "codex-hook",
  "message": "Codex needs approval",
  "project": "my-project",
  "updatedAt": 1710000000000
}
```

### `GET /events`

Returns recent in-memory status events. The service keeps the latest 200 events.

### `GET /diagnostics`

```json
{
  "ok": true,
  "currentStatus": {
    "agent": "codex",
    "state": "idle",
    "source": "manual",
    "message": "Codex is idle",
    "updatedAt": 1710000000000
  },
  "hookHealth": {
    "lastHookEventAt": 1710000000000,
    "lastHookState": "waiting_approval",
    "isHookRecentlyActive": true
  },
  "eventsCount": 12,
  "codexOpenSupport": {
    "appName": "Codex",
    "bundleId": "com.openai.codex",
    "deeplinkScheme": "codex://",
    "sessionIndexFound": true,
    "sessionIndexPath": "/Users/you/.codex/session_index.jsonl",
    "threadDeepLinkSupport": "best-effort"
  }
}
```

`isHookRecentlyActive` is true when a `source: "codex-hook"` event arrived in the last 10 minutes.

### `POST /open-session`

Attempts to open a visible session in Codex:

```bash
curl -s -X POST http://localhost:8787/open-session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::open-fallback-test"}'
```

Behavior:

- If the session has a trusted `codexThreadId`, the service tries `codex://threads/<codexThreadId>`.
- If no thread deeplink is available, it falls back to opening the Codex app.
- It does not copy anything to the clipboard.
- This endpoint does not change the session state.

## State Semantics

AgentWatch v0.3.1 fixes the state semantics around approval, completion, stale sessions, errors, and old migrated paths.

AgentWatch v0.3.2 keeps those semantics and adds focused approval UX / cleanup controls:

- Main panel `Dismiss all done (N)` hides only visible `done` sessions.
- Main panel `Approve all approval (N)` targets only visible `waiting_approval` sessions with `approvalRequired: true`.
- `Approve all approval` is currently a UI/API placeholder because no reliable underlying Codex approve action is available yet. It returns `approve_action_not_available` and does not mark sessions done.
- Each session has an independent `Details` toggle.
- Auto-approval events are recorded as diagnostics but do not trigger the red `waiting_approval` light.

States:

- `idle`: no visible sessions need attention. Gray light, label `Idle`. Idle sessions are hidden from the default tree and are mainly visible through debug/includeHidden views.
- `running`: Codex is actively working or using tools. Green light, label `Running`.
- `waiting_approval`: Codex explicitly requested manual user approval through `PermissionRequest`, with `approvalRequired: true`. Flashing red light, label `Approval Required`.
- `done`: Codex completed its response/task through the `Stop` hook and is waiting for human review. Blue/cyan light, label `Done`.
- `error`: a known failure or environment problem occurred, such as quota/usage limit, network failure, hook reporter failure, local service error, or tool/environment failure. Orange/yellow light, label `Error`.
- `stale`: the session was previously running, but AgentWatch has not received a new event for a long time, so the current state is no longer reliable. Purple slow-flashing light, label `Stale`.

Transition rules:

- `PermissionRequest -> waiting_approval` only when manual approval is required. Only visible sessions with `approvalRequired: true` participate in the overall red light. Dismissed sessions and cleaned-up missing paths do not.
- Auto approval events use `approvalMode: "auto"` and stay out of `waiting_approval`.
- If hooks do not report the approval mode, the panel shows `Approval mode: Not reported`.
- `Stop -> done`. Done stays visible until the user dismisses it. It does not automatically change to `idle` and does not auto-dismiss.
- `PostToolUse` is not `done`. It only means a tool finished, not that the agent's final response completed.
- `running -> stale` after `STALE_TIMEOUT_MS` without any new status event. The default is 10 minutes.
- `quota`, `usage limit`, `额度`, `rate limit`, or `limit reached` in error/message fields are normalized to `error` with reason `quota_or_usage_limit`.
- `waiting_approval` never becomes `stale` automatically. A real approval request must keep warning until another valid event overrides it or the user dismisses it.
- `Dismiss` only hides the AgentWatch panel item. It does not delete the Codex conversation.

Each session has reason fields:

```text
reasonCode
reasonMessage
lastHookEvent
lastCommandSummary
lastCwd
projectPathExists
approvalMode
approvalRequired
approvalRequestSummary
approvalRequestDetails
approvalLastEvent
```

Default session rows stay compact:

```text
displayTitle
State · duration · reasonMessage
[Open] [Details] [Dismiss]
```

Click `Details` on an individual session to expand reason code, last hook event, command summary, source, update time, duration, project path, project path existence, cwd, session id, and approval metadata.

Bulk cleanup:

```bash
curl -s -X POST http://localhost:8787/dismiss-all-done
```

Bulk approval placeholder:

```bash
curl -s -X POST http://localhost:8787/approve-all-approval
```

Until a real approve action exists, this returns `ok: false`, `reasonCode: "approve_action_not_available"`, and per-session failures for currently visible manual approval sessions.

Old project paths can leave historical sessions, especially old `PermissionRequest` events from before a project migration. Clean them without deleting Codex conversations:

```bash
curl -s -X POST http://localhost:8787/cleanup-missing-paths

curl -s -X POST http://localhost:8787/dismiss-project-path \
  -H "Content-Type: application/json" \
  -d '{"projectPath":"/old/path"}'
```

Test `done` persistence:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"reason-done","title":"Done persistence test","state":"done","source":"manual","message":"Completed","lastHookEvent":"Stop"}'
```

The session should show `Done · ... · Agent response completed` and remain visible until dismissed.

Test `stale` quickly:

```bash
STALE_TIMEOUT_MS=10000 npm run dev

curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"reason-stale","title":"Stale reason test","state":"running","source":"manual","message":"Codex is running"}'
```

After the timeout, the session should show `Stale` with reason `No status update after running`.

Test quota/error reason:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"quota-error","title":"Quota error test","state":"error","source":"manual","message":"Codex quota exhausted"}'
```

The session should show `Error · ... · Codex quota or usage limit reached`.

## Open in Codex

In the expanded AgentWatch panel, click a visible session row or its `Open` button to return to Codex.

When clicked, AgentWatch tries this sequence:

1. If the session has a valid `codexThreadId`, open `codex://threads/<codexThreadId>`.
2. If the session does not have a usable deeplink, open the Codex app by bundle id (`com.openai.codex`) or app name.
3. Ask macOS to activate Codex so it is brought to the foreground.
4. Leave the clipboard untouched.

This feature is best-effort. It does not use macOS Accessibility automation, does not simulate mouse clicks, and does not depend on the Codex window layout. Because of that, it does not guarantee that Codex will focus the exact input box for a thread. Exact thread focusing depends on Codex Desktop accepting the `codex://threads/<id>` deeplink.

Configure the app name if needed:

```bash
CODEX_APP_NAME="Codex" CODEX_BUNDLE_ID="com.openai.codex" npm run dev
```

Test a session with a thread deeplink:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"open-test","title":"Open in Codex 测试","state":"done","source":"manual","message":"Ready to open","codexThreadId":"00000000-0000-0000-0000-000000000000","codexDeepLink":"codex://threads/00000000-0000-0000-0000-000000000000"}'
```

Test fallback without a thread id:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"open-fallback-test","title":"Open fallback 测试","state":"waiting_approval","source":"manual","message":"Needs approval"}'

curl -s -X POST http://localhost:8787/open-session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::open-fallback-test"}'
```

Test `stale` quickly:

```bash
STALE_TIMEOUT_MS=10000 npm run dev
```

Then send:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"running","source":"manual","message":"Codex is running"}'
```

After about 10 seconds without any new status event, the light should show `Stale`. `/events` should include a `source: "system"` `stale` event. Stale means the session was previously running, but AgentWatch has not received a new event for a long time, so the displayed state may no longer be reliable. It does not mean failure or completion.

If Codex hooks are actively writing `running` events to port `8787`, the stale timer keeps resetting. For an isolated stale test, use the dedicated test server on port `8788`:

```bash
npm run dev:stale-test
```

Then send the running test to port `8788`:

```bash
curl -s -X POST http://localhost:8788/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"running","source":"manual","message":"Codex is running"}'
```

After 10 seconds:

```bash
curl -s http://localhost:8788/status
curl -s http://localhost:8788/events
```

If `done` returns to `idle` after about 3 seconds, an old Electron process is still running. Quit the floating window completely, confirm port `8787` is free, and start again:

```bash
lsof -ti tcp:8787
npm run dev
```

In the hierarchical version, `node scripts/diagnose.js` should show `Status version: v3-hierarchical` and the configured stale timeout.

## Hierarchical Status Model

Status v3 uses a three-level model:

```text
Overall
  Project
    Session
```

Session is the smallest state unit. `POST /status` updates one session. A project state is aggregated from its sessions, and the overall state is aggregated from all projects.

State priority:

```text
waiting_approval > error > stale > running > done > idle
```

Session key:

```text
id = projectId + "::" + sessionId
```

Different projects may use the same `sessionId`; the internal `id` stays unique because it includes `projectId`.

Tree APIs:

```bash
curl -s http://localhost:8787/status
curl -s http://localhost:8787/statuses
curl -s http://localhost:8787/sessions
curl -s http://localhost:8787/events
```

`GET /status` returns overall status for compatibility. `GET /statuses` returns the full `overall -> projects -> sessions` tree.

By default, `GET /statuses` only returns visible sessions. To include dismissed sessions for debugging:

```bash
curl -s "http://localhost:8787/statuses?includeHidden=true"
```

Dismiss semantics:

- `Dismiss` only hides a session from AgentWatch.
- It does not delete or stop anything in Codex.
- A dismissed session remains in memory with `visibility: "dismissed"` and `dismissedAt`.
- A dismissed session becomes visible again if it later receives a non-system `waiting_approval`, `error`, `running`, or `done` event.
- System transitions, such as `running -> stale`, do not redisplay a dismissed session.

Dismiss one session:

```bash
curl -s -X POST http://localhost:8787/dismiss-session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::session-a"}'
```

Correct a session title only when you are sure the session `id` belongs to that real Codex session:

```bash
curl -s -X POST http://localhost:8787/session-title \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::default-session","title":"Actual session title"}'
```

Later hook events that do not contain a title preserve the corrected title.
Title corrections are saved in `session-title-overrides.json` and survive app restarts. Do not copy a title from another project into a default session id; Codex Desktop may not expose the real title in hook payloads.

Correct a project display name when the Codex UI name differs from the local folder name:

```bash
curl -s -X POST http://localhost:8787/project-name \
  -H "Content-Type: application/json" \
  -d '{"projectId":"/Users/leoclaw/00_agent-runtime-bridge","projectName":"AI conversation localizer"}'
```

Project identity still uses `projectId` / `projectPath`; this only changes the displayed name. Corrections are saved in `project-name-overrides.json` and survive app restarts.

Dismiss a project:

```bash
curl -s -X POST http://localhost:8787/dismiss-project \
  -H "Content-Type: application/json" \
  -d '{"projectId":"/Users/leoclaw/Projects/AgentWatch"}'
```

Dismiss visible done sessions:

```bash
curl -s -X POST http://localhost:8787/clear-done
```

Session title generation:

```text
title > sessionName > latest user prompt summary > commandSummary > shortSessionId > projectName session
```

If the id contains `default-session`, it is not used as the display title.
For Codex hook events, `UserPromptSubmit` updates the session title from the user's actual request text. Attachment preambles such as `Files mentioned by the user` and image tags are ignored. The text is not translated; Chinese prompts produce Chinese titles, English prompts produce English titles.

Simulate two sessions in one project:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"session-a","sessionName":"修复 UI","state":"waiting_approval","source":"manual","message":"Needs approval"}'

curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Projects/AgentWatch","projectName":"AgentWatch","sessionId":"session-b","sessionName":"更新 README","state":"running","source":"manual","message":"Running"}'
```

The project and overall states should be `waiting_approval`.

Simulate another project:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Documents/BP","projectName":"BP","sessionId":"session-c","sessionName":"BP 修改","state":"running","source":"manual","message":"Running"}'
```

Delete one session:

```bash
curl -s -X DELETE http://localhost:8787/session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::session-a"}'
```

The response includes `deletedCount` and `deletedSessionIds`. If your shell or client has trouble sending a JSON body with `DELETE`, use `POST` or a URL-encoded query instead:

```bash
curl -s -X POST http://localhost:8787/session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Projects/AgentWatch::session-a"}'
```

Delete one project:

```bash
curl -s -X DELETE http://localhost:8787/project \
  -H "Content-Type: application/json" \
  -d '{"projectId":"/Users/leoclaw/Documents/BP"}'
```

The response also includes `deletedCount` and `deletedSessionIds`.

Dismiss completed sessions:

```bash
curl -s -X POST http://localhost:8787/clear-done
```

Codex hook reporter project/session extraction:

- `projectPath` comes from hook stdin `cwd` when available.
- `projectName` is the last path segment of `cwd`.
- `sessionId` uses `session_id`, `sessionId`, `thread_id`, `threadId`, `conversation_id`, or `conversationId`.
- `codexSessionId` keeps the raw Codex session-like id when available.
- `codexThreadId` is only filled from trusted id fields when the value itself looks like a UUID. Priority is `session_meta.payload.id`, then `thread_id` / `threadId`, then `session_id` / `sessionId`, then `conversation_id` / `conversationId`.
- `codexDeepLink` is generated as `codex://threads/<codexThreadId>` only when `codexThreadId` is valid.
- If no stable id exists, it falls back to a default session id derived from `cwd`.

Current limitation: if a Codex hook payload does not provide a real session/thread/conversation id, multiple same-project Codex sessions may still collapse into the same fallback `default-session`. The model is ready for stable ids when Codex provides them. AgentWatch does not treat full local session filenames as thread ids.

## Diagnostics

Run:

```bash
node scripts/diagnose.js
```

The script checks:

- `GET /health`
- `GET /status`
- `GET /diagnostics`
- user hooks file at `~/.codex/hooks.json`
- project hooks file at `.codex/hooks.json`
- whether a recent `source=codex-hook` event exists

Hook reporter smoke test:

```bash
echo '{"hook_event_name":"PermissionRequest","cwd":"/tmp"}' | node scripts/codex-hook-reporter.js waiting_approval
curl -s http://localhost:8787/events
```

The latest event should include:

```json
{
  "source": "codex-hook",
  "state": "waiting_approval"
}
```

## Install Codex Hooks

This repo includes `codex-hooks.example.json`, using the current documented Codex hook shape:

```text
hooks -> EventName -> matcher group -> command hook
```

The example uses `scripts/codex-hook-reporter.js`. The reporter reads hook payload JSON from stdin when Codex provides it, adds `source: "codex-hook"`, and posts to the local status service. If the status service is unavailable, it writes to `logs/codex-hook.log` and exits successfully so Codex is not blocked by the light.

Copy it to your user-level Codex hooks file:

```bash
mkdir -p ~/.codex
cp codex-hooks.example.json ~/.codex/hooks.json
```

Or copy it into a trusted project:

```bash
mkdir -p .codex
cp codex-hooks.example.json .codex/hooks.json
```

User-level hooks are usually simpler because they do not depend on whether a project-local `.codex/` layer is trusted.

## Verify Hooks In Codex CLI

1. Start AgentWatch with `npm run dev`.
2. Start Codex CLI in the project:

   ```bash
   codex -C /Users/leoclaw/Projects/AgentWatch
   ```

3. If Codex shows a hook review/trust flow, review and trust the hooks.
4. Submit a prompt or run a tool. The floating window should switch to `Running`.
5. Trigger a command that needs approval. The floating window should switch to flashing red `Approval Required`.
6. Run `node scripts/diagnose.js`; `Hook recently active` should be `yes`.

Codex hooks are enabled by default. If they have been disabled, make sure your Codex config does not contain:

```toml
[features]
hooks = false
```

## If Hooks Do Not Fire

Common causes:

- The AgentWatch app is not running, so `localhost:8787` is unavailable.
- `~/.codex/hooks.json` is not valid JSON.
- The hook definition changed and needs to be reviewed again with `/hooks`.
- Project-local `.codex/hooks.json` is ignored because the project is not trusted.
- Hooks are disabled in `config.toml` or by managed requirements.
- `curl` is not available in the shell environment Codex uses.
- The hook event or matcher behavior changed in your Codex version.
- A different service is already using port `8787`.

The example tracks the current Codex hook documentation available when this MVP was built. If a future Codex release changes event names, matcher behavior, or command hook fields, adjust `codex-hooks.example.json` accordingly.

## Codex CLI vs Codex Desktop

Current validation:

- Codex CLI can read `~/.codex/hooks.json`.
- Codex CLI shows the hook trust flow for new or changed command hooks.
- Codex CLI successfully triggers `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`.
- `PermissionRequest` can update AgentWatch to `waiting_approval` with `source: "codex-hook"`.
- `Stop` maps to `done`, not `idle`; the completed session stays visible until you dismiss it.

Codex Desktop App supports command hooks in current testing, but each project or surface may require a hook review/trust flow before the commands run. If Desktop does not turn the light red, first open the hooks configuration UI and confirm the five hooks are enabled: `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, and `Stop`.

Recommended workflow:

1. Verify the hook chain with Codex CLI first.
2. Run `node scripts/diagnose.js` to confirm whether recent `codex-hook` events are arriving.
3. If Desktop does not trigger hooks, review/trust the hooks in that project and start a new conversation if needed.
4. Add or enable a future fallback monitor, such as `codex-desktop-monitor` or `browser-monitor`, if a surface still does not emit hooks.

Internal Codex tasks can also emit hooks. By default, `scripts/codex-hook-reporter.js` ignores `~/.codex/memories`, so the internal memory writing agent does not appear as a user project named `memories`. To customize ignored paths, set `AGENTWATCH_IGNORE_PATHS` to a path-delimited list. The older `AGENT_STATUS_LIGHT_IGNORE_PATHS` name is still accepted for existing hook setups.

## Configuration

Optional local config:

```bash
cp config.example.json config.json
```

Supported fields:

```json
{
  "port": 8787,
  "codexAppName": "Codex",
  "codexBundleId": "com.openai.codex",
  "staleTimeoutMs": 600000,
  "enableSound": true,
  "enableNotifications": true,
  "enableWled": false,
  "wledDeviceUrl": "http://192.168.1.xxx"
}
```

Environment variables override `config.json`:

- `STATUS_LIGHT_PORT`
- `STALE_TIMEOUT_MS`
- `ENABLE_SOUND`
- `ENABLE_NOTIFICATIONS`
- `ENABLE_WLED`
- `WLED_DEVICE_URL`

## WLED Extension

If `ENABLE_WLED=true` or `enableWled` is set in `config.json`, the app posts to:

```text
<WLED_DEVICE_URL>/json/state
```

Current mapping:

- `running` -> green
- `waiting_approval` -> red effect
- `idle` -> dim gray
- `done` -> blue
- `error` -> orange
- `stale` -> purple slow effect

## Current Limits

- State is stored in memory only.
- The menu bar icon is implemented for macOS first.
- `npm run pack` creates a local `.app`; signed installers are not included yet.
- Launch at Login uses Electron login item settings and should be verified from the packaged app.
- Apple Developer signing and notarization are not configured.
- Automatic updates are not implemented.
- The optional sound is currently a terminal bell; platform-specific audio can be added later.
- Codex Desktop hook support is not assumed. The app now tracks `source` so CLI hooks, manual updates, and future fallback monitors can be distinguished.
- `stale` only means no fresh status event arrived while the state was `running`; it does not prove Codex is actually stuck.
- Future Desktop/browser fallback monitors are not implemented yet.
