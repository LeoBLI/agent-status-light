Status: v0.1.0 — working local MVP for Codex CLI/Desktop hooks.
# Agent Status Light

Agent Status Light is a local desktop status light for Codex. It accepts status updates from multiple signal sources, serves a unified status API on `http://localhost:8787`, and shows a small always-on-top Electron floating window.

```text
Signal Sources
  - manual
  - codex-hook
  - future: codex-desktop-monitor
  - future: browser-monitor
        ↓
Unified status service
        ↓
Electron floating light
```

## Features

- Local HTTP status service with `GET /status`, `POST /status`, `GET /events`, and `GET /diagnostics`.
- Frameless, always-on-top floating window.
- Status v2 display: gray `idle`, green `running`, flashing red `waiting_approval`, blue/cyan `done`, orange `error`, purple slow-flashing `stale`.
- Click the window to expand or collapse status and hook-health details.
- Desktop notification and terminal bell when approval is needed.
- Optional WLED/ESP32 HTTP integration.

## Install

```bash
cd /Users/leoclaw/Documents/AgentLight/agent-status-light
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
  "project": "optional project name"
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
  "eventsCount": 12
}
```

`isHookRecentlyActive` is true when a `source: "codex-hook"` event arrived in the last 10 minutes.

## Status v2

States:

- `idle`: no active work. Gray light, label `Idle`.
- `running`: Codex is actively working or using tools. Green light, label `Running`.
- `waiting_approval`: Codex needs user approval. Flashing red light, label `Approval Required`.
- `done`: the last task just completed. Blue/cyan light, label `Done`.
- `error`: the agent or service hit an error. Orange/yellow light, label `Error`.
- `stale`: Codex was running, but no fresh status event arrived before the stale timeout. Purple slow-flashing light, label `Stale`.

Transition rules:

- `waiting_approval` has the highest visual priority and never becomes `stale` automatically.
- `done` stays visible until the user dismisses it. It does not automatically change to `idle`.
- `running` becomes `stale` after 10 minutes without any new valid status event.
- Override the stale timeout for development with `STALE_TIMEOUT_MS=10000`.
- Any new valid state event can replace `stale`.
- `error` does not automatically return to `idle`; send another state event to clear it.

The expanded UI shows the full project/session tree. Done sessions show a `Dismiss` button.

Test `done`:

```bash
curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","state":"done","source":"manual","message":"Task completed"}'
```

The session should show `Done` and remain visible until dismissed.

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

After about 10 seconds without any new status event, the light should show `Stale`. `/events` should include a `source: "system"` `stale` event. Stale means the session was previously running, but Agent Status Light has not received a new event for a long time, so the displayed state may no longer be reliable. It does not mean failure or completion.

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

- `Dismiss` only hides a session from Agent Status Light.
- It does not delete or stop anything in Codex.
- A dismissed session remains in memory with `visibility: "dismissed"` and `dismissedAt`.
- A dismissed session becomes visible again if it later receives a non-system `waiting_approval`, `error`, `running`, or `done` event.
- System transitions, such as `running -> stale`, do not redisplay a dismissed session.

Dismiss one session:

```bash
curl -s -X POST http://localhost:8787/dismiss-session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Documents/AgentLight/agent-status-light::session-a"}'
```

Correct a session title only when you are sure the session `id` belongs to that real Codex session:

```bash
curl -s -X POST http://localhost:8787/session-title \
  -H "Content-Type: application/json" \
  -d '{"id":"AgentLight::AgentLight::default-session","title":"Actual session title"}'
```

Later hook events that do not contain a title preserve the corrected title.
Title corrections are saved in `session-title-overrides.json` and survive app restarts. Do not copy a title from another project into a default session id; Codex Desktop may not expose the real title in hook payloads.

Dismiss a project:

```bash
curl -s -X POST http://localhost:8787/dismiss-project \
  -H "Content-Type: application/json" \
  -d '{"projectId":"/Users/leoclaw/Documents/AgentLight/agent-status-light"}'
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
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Documents/AgentLight/agent-status-light","projectName":"agent-status-light","sessionId":"session-a","sessionName":"修复 UI","state":"waiting_approval","source":"manual","message":"Needs approval"}'

curl -s -X POST http://localhost:8787/status \
  -H "Content-Type: application/json" \
  -d '{"agent":"codex","projectPath":"/Users/leoclaw/Documents/AgentLight/agent-status-light","projectName":"agent-status-light","sessionId":"session-b","sessionName":"更新 README","state":"running","source":"manual","message":"Running"}'
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
  -d '{"id":"/Users/leoclaw/Documents/AgentLight/agent-status-light::session-a"}'
```

The response includes `deletedCount` and `deletedSessionIds`. If your shell or client has trouble sending a JSON body with `DELETE`, use `POST` or a URL-encoded query instead:

```bash
curl -s -X POST http://localhost:8787/session \
  -H "Content-Type: application/json" \
  -d '{"id":"/Users/leoclaw/Documents/AgentLight/agent-status-light::session-a"}'
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
- If no stable id exists, it falls back to a default session id derived from `cwd`.

Current limitation: if a Codex hook payload does not provide a real session/thread/conversation id, multiple same-project Codex sessions may still collapse into the same fallback `default-session`. The model is ready for stable ids when Codex provides them.

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

1. Start Agent Status Light with `npm run dev`.
2. Start Codex CLI in the project:

   ```bash
   codex -C /Users/leoclaw/Documents/AgentLight/agent-status-light
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

- The Agent Status Light app is not running, so `localhost:8787` is unavailable.
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
- `PermissionRequest` can update Agent Status Light to `waiting_approval` with `source: "codex-hook"`.
- `Stop` maps to `done`, not `idle`, so you can see that the previous task just completed before the light returns to idle automatically.

Codex Desktop App may behave differently in some versions or surfaces. It may not execute `~/.codex/hooks.json` command hooks, or it may not display the same hook trust flow. If Desktop does not turn the light red, that is not necessarily an Agent Status Light service problem.

Recommended workflow:

1. Verify the hook chain with Codex CLI first.
2. Run `node scripts/diagnose.js` to confirm whether recent `codex-hook` events are arriving.
3. If Desktop does not trigger hooks, use Codex CLI for hook-based status updates for now.
4. Add or enable a future fallback monitor, such as `codex-desktop-monitor` or `browser-monitor`, when Desktop hook support is unavailable.

## Configuration

Optional local config:

```bash
cp config.example.json config.json
```

Supported fields:

```json
{
  "port": 8787,
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
- The UI displays the latest single status, although `agent` and `project` are preserved for future multi-agent support.
- No packaged installer is included yet.
- The optional sound is currently a terminal bell; platform-specific audio can be added later.
- Codex Desktop hook support is not assumed. The app now tracks `source` so CLI hooks, manual updates, and future fallback monitors can be distinguished.
- `stale` only means no fresh status event arrived while the state was `running`; it does not prove Codex is actually stuck.
- Future Desktop/browser fallback monitors are not implemented yet.
