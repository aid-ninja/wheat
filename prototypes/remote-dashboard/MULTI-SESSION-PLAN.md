# Multi-Session Server Refactor Plan

> Based on claims r003, r004, w002. This is a PLAN, not a full implementation.

## 1. SessionState Class

```javascript
class SessionState {
  constructor(sessionId, cwd) {
    this.id = sessionId;
    this.label = cwd ? cwd.split('/').pop() : sessionId.slice(0, 8);
    this.cwd = cwd || '';
    this.color = SessionState.hueFromId(sessionId); // stable color
    this.status = 'active';           // 'active' | 'stale' | 'ended'
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.source = null;               // 'startup' | 'resume' | 'clear' | 'compact'

    // Per-session state (currently global singletons)
    this.pending = new Map();         // requestId -> { resolve, data, timestamp }
    this.activity = [];               // last 200 events for this session
    this.messages = [];               // last 50 Claude messages for this session
    this.trustLevel = 'paranoid';     // 'paranoid' | 'standard' | 'autonomous'
    this.sessionRules = [];           // [{tool, pattern?}]
    this.agents = [];                 // agent tracking
  }

  static hueFromId(id) {
    // Deterministic hue from session UUID — same ID always gets same color
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isStale(timeoutMs = 5 * 60 * 1000) {
    return this.status === 'active' && (Date.now() - this.lastActivity) > timeoutMs;
  }
}
```

## 2. getSession(id) Lazy Initializer

```javascript
const sessions = new Map();  // session_id -> SessionState

function getSession(sessionId, cwd) {
  if (!sessions.has(sessionId)) {
    const session = new SessionState(sessionId, cwd);
    sessions.set(sessionId, session);
    broadcast({ type: 'session_new', data: sessionSummary(session) });
  }
  const s = sessions.get(sessionId);
  s.touch();
  return s;
}

function sessionSummary(s) {
  return {
    id: s.id,
    label: s.label,
    color: s.color,
    status: s.status,
    cwd: s.cwd,
    pending_count: s.pending.size,
    trust: s.trustLevel,
    startedAt: s.startedAt,
    lastActivity: s.lastActivity
  };
}
```

## 3. Global Variables That Become Per-Session

| Current global | Becomes | Notes |
|---|---|---|
| `pending` (Map) | `session.pending` | Permission requests are session-scoped |
| `activity` (Array) | `session.activity` | Activity feed per session |
| `messages` (Array) | `session.messages` | Claude text messages per session |
| `trustLevel` (string) | `session.trustLevel` | Each session can have different trust |
| `sessionRules` (Array) | `session.sessionRules` | Auto-approve rules per session |
| `agents` (Array) | `session.agents` | Subagent tracking per session |

**Remain global:**
- `claimsData` / `compilationData` — shared across sessions (sprint-level, not session-level)
- SSE client connections — fan out to all connected browsers
- `PORT`, `TOKEN`, config — server-level

## 4. SSE Broadcast Tagging

Every SSE message must include `session_id` so the dashboard can filter client-side:

```javascript
function broadcast(msg) {
  // Inject session_id into every broadcast
  const payload = JSON.stringify(msg);
  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// All handler functions pass session_id through:
function handlePermission(req, body) {
  const { session_id } = body;
  const session = getSession(session_id, body.cwd);
  // ... session.pending.set(requestId, ...)
  broadcast({
    type: 'permission_request',
    session_id,              // <-- tagged
    session_label: session.label,
    session_color: session.color,
    data: { /* permission details */ }
  });
}
```

## 5. SessionStart/SessionEnd Hooks via curl (w002 constraint)

w002 found that SessionStart and SessionEnd only support `type: "command"` hooks — not HTTP. This means we need a curl wrapper in the hooks config.

### hooks-config.json additions

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "curl -s -X POST http://localhost:9090/hooks/lifecycle -H 'Content-Type: application/json' -H 'Authorization: Bearer $FARMER_TOKEN' -d '{\"event\":\"session_start\",\"session_id\":\"'$CLAUDE_SESSION_ID'\",\"source\":\"'$CLAUDE_SESSION_SOURCE'\",\"cwd\":\"'$(pwd)'\"}'",
        "timeout": 5000
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "curl -s -X POST http://localhost:9090/hooks/lifecycle -H 'Content-Type: application/json' -H 'Authorization: Bearer $FARMER_TOKEN' -d '{\"event\":\"session_end\",\"session_id\":\"'$CLAUDE_SESSION_ID'\",\"reason\":\"'$CLAUDE_SESSION_REASON'\"}'",
        "timeout": 5000
      }
    ]
  }
}
```

**Note:** The actual environment variable names for session_id/source/reason in command-type hooks need verification. The hook receives the payload on stdin as JSON — a more robust approach:

```json
{
  "type": "command",
  "command": "curl -s -X POST http://localhost:9090/hooks/lifecycle -H 'Content-Type: application/json' -H 'Authorization: Bearer $FARMER_TOKEN' -d @-"
}
```

This pipes stdin (the hook's JSON payload) directly to curl, which forwards it to the server. Simpler and avoids shell escaping issues.

### New server endpoint: POST /hooks/lifecycle

```javascript
function handleLifecycle(req, body) {
  const { event, session_id, cwd, source, reason } = body;

  if (event === 'session_start') {
    const session = getSession(session_id, cwd);
    session.source = source;  // 'startup', 'resume', 'clear', 'compact'
    session.status = 'active';
    broadcast({ type: 'session_start', session_id, data: sessionSummary(session) });
  }

  if (event === 'session_end') {
    const session = sessions.get(session_id);
    if (session) {
      session.status = 'ended';
      session.endedAt = Date.now();
      session.endReason = reason;
      // Auto-deny any pending permissions for this session
      for (const [reqId, entry] of session.pending) {
        entry.resolve({ decision: 'deny', reason: 'session ended' });
        session.pending.delete(reqId);
      }
      broadcast({ type: 'session_end', session_id, data: { reason } });
    }
  }
}
```

## 6. Dashboard Session Switcher UI

### Concept: Pill bar at top of dashboard

```
[All Sessions] [wheat (a3f2)] [api-server (b7c1)] [docs (ended)]
                  🟢 2 pending    🟡 idle           ⚫ ended
```

**Design principles (from r005):**
- Default view: unified feed with all sessions, color-coded
- Pill bar filters to one session — CSS class toggle, not page reload
- Each pill shows: cwd-derived label, first 4 chars of session_id, status dot
- Active sessions with pending permissions pulse/glow
- Ended sessions gray out but remain visible for history
- Mobile: horizontal scroll on pill bar, single-column feed below

### Client-side filtering

```javascript
let activeFilter = null; // null = all sessions

function setSessionFilter(sessionId) {
  activeFilter = sessionId;
  document.querySelectorAll('.activity-item, .permission-card').forEach(el => {
    if (activeFilter && el.dataset.sessionId !== activeFilter) {
      el.style.display = 'none';
    } else {
      el.style.display = '';
    }
  });
  // Update pill bar active state
  document.querySelectorAll('.session-pill').forEach(pill => {
    pill.classList.toggle('active', pill.dataset.sessionId === activeFilter);
  });
}
```

### Session color assignment

```javascript
function sessionColor(sessionId) {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i++) {
    hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
}
```

## 7. Staleness Detection

```javascript
// Run every 60 seconds
setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.isStale()) {
      session.status = 'stale';
      broadcast({ type: 'session_stale', session_id: id });
    }
  }
}, 60_000);
```

## 8. Migration Path (backwards compatibility per d004)

1. If no `session_id` in a hook payload, treat it as a `"default"` session — single-session behavior preserved
2. The `getSession("default")` path means existing hooks-config.json works without changes
3. SessionStart/SessionEnd hooks are additive — existing PreToolUse/PostToolUse hooks continue to work
4. Dashboard detects single-session mode (only "default" session) and hides the session switcher

## Implementation Order

1. Add `SessionState` class and `sessions` Map to server.mjs
2. Add `getSession()` with "default" fallback
3. Refactor each handler to use `session.pending` instead of global `pending`, etc.
4. Add `/hooks/lifecycle` endpoint
5. Tag all SSE broadcasts with `session_id`
6. Add session pill bar to dashboard HTML
7. Add client-side filtering
8. Add staleness detection interval
9. Test with two concurrent `claude` sessions using curl-based SessionStart hooks

Estimated effort: 2-4 hours (consistent with r008).
