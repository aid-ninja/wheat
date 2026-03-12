# State Persistence — Remote Farmer Reliability

## The Problem

The Remote Farmer server (`prototypes/remote-dashboard/server.mjs`) stores **all state in memory**. If the process crashes, is killed, or restarts:

- All session data is lost (trust levels, rules, activity logs)
- Pending permission requests are silently dropped (no deny sent to Claude Code)
- The audit trail disappears
- Users must reconfigure trust levels and session rules from scratch

This was identified as an unaddressed dependency gap in the blind-spot analysis.

## What State Exists

### In-memory structures (server.mjs)

| Structure | Location | Size | Volatility |
|-----------|----------|------|------------|
| `sessions` Map | line 76 | SessionState per session | Grows with connections |
| `SessionState.pending` | line 50 | Map of requestId -> {resolve, data} | High churn |
| `SessionState.activity` | line 51 | Last 200 events per session | Append-only, capped |
| `SessionState.messages` | line 52 | Last 50 messages per session | Append-only, capped |
| `SessionState.trustLevel` | line 53 | Single string per session | Rarely changes |
| `SessionState.sessionRules` | line 54 | Array of {tool, pattern} | Rarely changes |
| `SessionState.agents` | line 55 | Agent tracking entries | Session-scoped |
| `sseClients` Set | line 241 | Active SSE connections | Transient |
| `claimsData` / `compilationData` | lines 107-108 | Parsed JSON from disk | Already persisted (file-backed) |

### Persistence classification

**Must persist** (r040):
- **Trust levels** — User configuration. Tedious to re-enter, especially across multiple sessions.
- **Session rules** — User-defined auto-approve patterns. Same reasoning.
- **Activity log** — Audit trail with compliance value. Losing it means no record of what was approved/denied.

**Should NOT persist**:
- **Pending permissions** — Contain HTTP response objects (not serializable). Become stale after restart. Claude Code re-sends permission requests on reconnect.
- **SSE client connections** — Transient socket references. Clients reconnect automatically via EventSource.

**Optional**:
- **Session metadata** (label, color, cwd) — Useful for continuity but auto-reconstructed from the next hook payload.
- **Messages buffer** — Moderate value for context, but bounded (50 per session) and low reconstruction cost.

## Approaches Evaluated

### 1. JSON File Snapshots (recommended) — r039

Write recoverable state to `farmer-state.json` using `fs.writeFileSync`.

**Implementation**:
```javascript
import { writeFileSync, readFileSync, renameSync, existsSync } from 'node:fs';

const STATE_PATH = resolve(__dirname, 'farmer-state.json');

function saveState() {
  const state = {
    savedAt: Date.now(),
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id, trustLevel: s.trustLevel,
      sessionRules: s.sessionRules,
      activity: s.activity,
      label: s.label, color: s.color, cwd: s.cwd,
    })),
  };
  // Atomic write: temp file then rename
  const tmp = STATE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_PATH);
}

function loadState() {
  if (!existsSync(STATE_PATH)) return;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    for (const s of state.sessions) {
      const session = getSession(s.id, s.cwd);
      session.trustLevel = s.trustLevel;
      session.sessionRules = s.sessionRules || [];
      session.activity = s.activity || [];
    }
  } catch { /* ignore corrupt state file */ }
}
```

**Trigger points**:
- On trust level change (`handleTrustLevel`)
- On rule add/remove (`handleRules`)
- Periodic flush every 30 seconds (catches activity log updates)
- On graceful shutdown (SIGTERM/SIGINT)

**Pros**: Zero deps, simple, small file (<100KB), <1ms write on SSD.
**Cons**: Up to 30s of activity data lost on hard crash (SIGKILL). Acceptable for a dev tool.

### 2. Append-Only Log (event sourcing lite) — r042

Write every state-changing event as a JSON line to an append-only log file.

**Pros**: No data loss window (every event is immediately persisted). Full replay capability.
**Cons**: Over-engineered for this scale. Requires log compaction, replay logic, schema evolution handling. The full state is <100KB — snapshot is simpler and sufficient.

**Verdict**: Not recommended as initial approach. Consider only if state file exceeds 1MB or write frequency exceeds 10/sec.

### 3. SQLite via better-sqlite3

**Pros**: ACID transactions, query capability, battle-tested.
**Cons**: **Violates d004 (zero npm dependencies)**. Immediately disqualified.

### 4. Process Signal Handlers (complementary) — r041

Not a persistence strategy by itself, but essential companion to any approach:

```javascript
function gracefulShutdown(signal) {
  console.log(`\n  [${signal}] Shutting down gracefully...`);
  // Deny all pending permissions
  for (const [sid, session] of sessions) {
    for (const [reqId, entry] of session.pending) {
      entry.resolve({ allow: false, reason: `Server shutting down (${signal})` });
    }
  }
  // Flush state
  saveState();
  // Broadcast shutdown to dashboard clients
  broadcast({ type: 'server_shutdown', data: { signal } });
  // Close server
  server.close(() => process.exit(0));
  // Force exit after 3s if close hangs
  setTimeout(() => process.exit(1), 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

## Recommendation

**Phase 1**: JSON snapshots + signal handlers (~40 lines of code)
- Covers 95% of the problem with minimal complexity
- Atomic writes prevent corruption
- Graceful shutdown denies pending requests cleanly
- Activity log preserved across restarts

**Phase 2** (if needed): Periodic auto-save + dashboard indicator
- Show "last saved: Xs ago" in dashboard footer
- Configurable save interval via `--save-interval` flag

## Claims

| ID | Type | Content |
|----|------|---------|
| r038 | risk | All state in memory, total loss on crash/restart |
| r039 | recommendation | JSON file snapshots with atomic write |
| r040 | factual | State classification: must-persist vs ephemeral |
| r041 | recommendation | Signal handlers for graceful shutdown |
| r042 | estimate | Event sourcing is over-engineered at this scale |

## Conflicts

- **r034** (security): Notes that "restarting the server loses in-memory session state" as a negative consequence of token rotation. State persistence (r039) directly addresses this — token rotation becomes cheaper when state survives restart.
- **d004** (constraint): Zero npm deps. All recommendations here use only Node built-in modules (`fs`, `process`). No conflicts.
