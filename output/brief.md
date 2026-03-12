# Remote Farmer — Architecture Recommendation

> Remote permission dashboard for Claude Code
> Claims hash: 473da3f | 56 claims | 10 topics | ~650 LOC prototype

---

## Executive Summary

Remote Farmer is a zero-dependency Node.js server that intercepts Claude Code's permission requests via HTTP hooks and relays them to a browser dashboard. A remote user approves or denies each tool call from their phone, with the decision relayed back synchronously before Claude Code proceeds. [r001] [p001]

No patching, no forking, no subprocess wrapping. The hook system is the entire integration surface — and the prototype proves it works end-to-end, including remote access from an iPhone via Cloudflare Tunnel. [d001] [p007] [p012]

**Key numbers:** 56 claims, 10 topics, ~650 LOC prototype, 0 npm dependencies [p003]

---

## How It Works

### Architecture

```
Claude Code CLI
  │
  ├── PreToolUse hook ───────POST──► localhost:9090/hooks/permission
  ├── PostToolUse hook ──────POST──► localhost:9090/hooks/activity
  ├── PostToolUseFailure ────POST──► localhost:9090/hooks/activity
  └── Notification hook ─────POST──► localhost:9090/hooks/notification
                                              │
                                    Remote Farmer Server (Node.js)
                                              │
                                    SSE push + polling fallback
                                              │
                                       Browser Dashboard
                                    (approve / deny / monitor)
```

### Permission Flow

1. Claude Code fires a `PreToolUse` hook POST to `localhost:9090` [r001]
2. Server checks trust tier — auto-approves if rules match [p009]
3. If not auto-approved, holds HTTP response and pushes to browser [p002]
4. User taps Approve or Deny on the dashboard
5. Server responds with allow/deny JSON [r002]
6. Claude Code proceeds (or halts) based on the decision

### Connectivity

SSE (Server-Sent Events) for local connections. Cloudflare and other reverse proxies buffer SSE, so the dashboard auto-detects this and falls back to polling `/api/state` every 2 seconds. State diff prevents UI flash on re-render. [p007] [p011]

---

## Security Model

### Fail-Deny on Timeout [x001] [x008]

Empty JSON `{}` on 2xx means auto-allow in Claude Code. The timeout handler returns an explicit deny decision. This is the single most important security property of the system.

### Fail-Open on Server Crash [x002]

If the server crashes or network drops, non-2xx / timeout = Claude Code proceeds as if no hook exists. **Unfixable from dashboard side** — it is Claude Code's design choice. Mitigate with a local command hook that checks server health. [x010]

### Hardening [p010]

- Hook endpoints restricted to localhost (remoteAddress check)
- Request body capped at 1MB
- Token comparison uses `crypto.timingSafeEqual`
- Regex patterns escape special chars (ReDoS prevention)
- Dangerous Bash patterns flagged visually in dashboard

### Auth Layers [p005] [r009]

- **Inner:** Random hex token (or `--token` flag), required for all dashboard/API access
- **Outer:** Tunnel auth (Cloudflare Zero Trust email OTP, or ngrok basic auth)

---

## Trust Tiers [p009]

| Tier | Behavior | Best For |
|------|----------|----------|
| **Paranoid** | Approve everything manually | Security-sensitive ops |
| **Standard** | Auto-approve Read/Grep/Glob/WebSearch/WebFetch | Daily development |
| **Autonomous** | Auto-approve all except dangerous Bash | Trusted codebases, max speed |

Standard mode eliminates approval fatigue for safe read-only tools while keeping write/execute under remote control. Autonomous mode was tested live — only `rm`, `git push`, `sudo`, `curl|sh`, and similar patterns require approval. [r030] [r032]

### Session Rules

Dashboard exposes checkbox rules by tool category. Users can also add per-tool rules from "Quick Rules" dropdown on each permission card. Rules persist in server memory for the session. [r028] [r031]

---

## Tested Findings

### Cloudflare Tunnel [p007] [p012]

- `cloudflared tunnel --url http://localhost:9090` works with no account
- SSE is **buffered** by Cloudflare despite `X-Accel-Buffering: no` headers
- Polling fallback required — auto-detected after 4s SSE silence
- Tunnel URL changes on each `cloudflared` restart (use named tunnels for persistence)
- Quick tunnels have no SLA but work fine for dev sessions

### iOS Safari [p008]

- `Notification` API does not exist — `typeof Notification === 'undefined'`
- All references must be guarded or dashboard JS crashes silently
- `env(safe-area-inset-top)` needed for iPhone Dynamic Island
- `viewport-fit=cover` required in meta viewport

### Hook Behavior [r004] [x001]

- HTTP hooks are fail-open by design (non-2xx = proceed)
- Empty JSON `{}` on 2xx = auto-allow (critical security footgun)
- `PreToolUse` fires before every tool regardless of permission config
- Notification hooks are non-blocking (fire and forget, can't relay user input)

---

## Limitations

### No Remote Text Input [r023] [r024]

Hooks cannot answer `AskUserQuestion` prompts. Questions are visible on dashboard but unanswerable — the Notification hook is fire-and-forget. Text conversation must stay in the terminal.

### Fail-Open Is Unfixable [x002]

Server crash = permissions silently granted. Hybrid command hook is the best workaround. [x010]

### No Hot-Reload [r007]

Hook config loaded at session startup. Changes require session restart.

---

## Tunneling

| Option | Auth | Setup | Free Tier | Tested |
|--------|------|-------|-----------|--------|
| **Cloudflare Tunnel** | Zero Trust email OTP [r019] | ~2 min | Free/50 users | Yes [p007] [p012] |
| **ngrok** | `--basic-auth` [r017] | ~1 min | 1 GB/mo + interstitial [r016] | No |
| **Tailscale Funnel** | ACL-based [r020] | ~5 min | Free personal | No |

**Recommendation:** Cloudflare Tunnel for sessions. Requires polling fallback but otherwise works well. Named tunnel + Zero Trust Access for recurring use. [r022]

---

## Recommendation

**Ship the prototype.** The 650-line Node.js server with self-contained HTML dashboard covers the core use case: remote permission approval from a phone over a tunneled connection. Trust tiers solve the approval fatigue problem. Polling fallback handles proxy compatibility.

**What to build next:**
1. Hybrid fail-safe command hook (closes fail-open gap) [x010]
2. Named Cloudflare tunnel with stable URL
3. `updatedInput` sandboxing for Autonomous mode [r032]

**What to wait for:**
- Claude Code API for remote text injection [r023]
- Fail-closed HTTP hook mode [x002]
- Hot-reloadable hook config [r007]

---

*Claims hash 473da3f — Compiled by Wheat*
