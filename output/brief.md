# Remote Farmer — Architecture Recommendation

> Remote permission dashboard for Claude Code
> Claims hash: 51751a2 | 50 claims | 10 topics | ~550 LOC prototype

---

## Executive Summary

Remote Farmer is a zero-dependency Node.js server that intercepts Claude Code's permission requests via HTTP hooks and relays them to a browser dashboard over SSE. A remote user approves or denies each tool call from their phone or laptop, with the decision relayed back synchronously before Claude Code proceeds. [r001] [p001]

No patching, no forking, no subprocess wrapping. The hook system is the entire integration surface — and the prototype proves it works exactly as documented. [d001] [r014]

**Key numbers:** 50 claims, 10 topics, ~550 LOC prototype [p003]

---

## How It Works

### Architecture

```
Claude Code CLI
  │
  ├── PermissionRequest hook ──POST──► localhost:9090/hooks/permission
  ├── PostToolUse hook ────────POST──► localhost:9090/hooks/activity
  └── PostToolUseFailure hook ─POST──► localhost:9090/hooks/activity
                                              │
                                    Remote Farmer Server (Node.js)
                                              │
                                         SSE push
                                              │
                                       Browser Dashboard
                                    (approve / deny / monitor)
```

### Permission Flow

1. Claude Code fires a `PermissionRequest` hook POST to `localhost:9090` [r001]
2. Server holds the HTTP response open in a pending map [p002]
3. SSE pushes the request to all connected browsers [p004]
4. User taps Approve or Deny on the dashboard
5. Server responds to the held request with allow/deny JSON [r002]
6. Claude Code proceeds (or halts) based on the decision

### Activity Feed

`PostToolUse` and `PostToolUseFailure` hooks fire after every tool execution — success or failure. These are non-blocking, so they feed a real-time activity stream without any performance impact on Claude Code. [r006]

---

## Security Model

### Fail-Deny on Timeout [x001] [x008]

Empty JSON `{}` on 2xx means auto-allow in Claude Code. The original timeout handler would have silently granted every timed-out permission. **Fixed:** timeout now returns an explicit deny decision. This is the single most important security property of the system.

### Fail-Open on Server Crash [x002]

If the Remote Farmer server crashes or the network drops, non-2xx / timeout = non-blocking error = Claude Code proceeds as if no hook exists. This is **unfixable from the dashboard side** — it is Claude Code's design choice.

### Hybrid Hook Mitigation [x010]

HTTP hook for the dashboard UI, plus a local **command hook** that checks if the dashboard server is alive before allowing any tool call. Command hooks with exit code 2 *are* blocking errors, unlike HTTP hooks. This closes the fail-open gap.

### Auth Layers [p005] [r009]

- **Inner layer:** Random 16-byte hex token generated on startup, required for dashboard and SSE access.
- **Outer layer:** Tunnel auth (ngrok basic auth or Cloudflare Zero Trust email OTP).

---

## Trust Tiers [r030]

| Tier | Behavior | Best For |
|------|----------|----------|
| **Paranoid** | Approve everything manually | Security-sensitive ops, unfamiliar codebases |
| **Standard** | Auto-approve reads (Read, Grep, Glob, WebSearch), require approval for writes | Daily development — good balance of speed and safety [r028] |
| **Autonomous** | Auto-approve all except dangerous Bash (`rm`, `git push`, `curl\|sh`) | Trusted codebases, maximum speed [r032] |

### Batch Approval [r028] [r031]

`PreToolUse` hooks fire before every tool call regardless of permission status. Server maintains an in-memory allow-list with regex matching. Dashboard exposes a rules panel with category checkboxes and file-path patterns.

### Persistent Rules [r029]

`updatedPermissions` in `PermissionRequest` responses persists "always allow" rules into Claude Code's own permission system — survives session restarts.

---

## Limitations

### No Remote Text Input [r023] [r024]

Hooks cannot inject user prompts or answer AskUserQuestion dialogs. `AskUserQuestion` triggers a Notification hook (observe-only, cannot respond). The question is visible on the dashboard but unanswerable.

**Workaround:** Detect the dialog via Notification hook, collect the answer on the dashboard, inject it via `additionalContext` on the next hook response as "[Remote user answered: ...]". Not seamless, but functional. [r025] [r026]

### No Hot-Reload [r007]

Hook JSON config is loaded at session startup. Mid-session changes require `/hooks` menu interaction or session restart. The dashboard cannot dynamically reconfigure which tools need approval without restarting Claude Code.

### Fail-Open Is Unfixable [x002]

If the dashboard server is unreachable, permissions are silently granted. The hybrid command hook mitigation [x010] is the best available workaround, but cannot be enforced from the dashboard alone.

---

## Tunneling Options

| Option | Auth | Trust Model | Setup | Free Tier | Best For |
|--------|------|-------------|-------|-----------|----------|
| **ngrok** | Basic auth via `--basic-auth` [r017] | Traffic routes through ngrok infra | ~1 min | 1 GB/mo, interstitial page [r016] | Quick one-off demos |
| **Cloudflare Tunnel** | Zero Trust Access, email OTP [r019] | Your own CF account | ~5 min | Free for 50 users [r018] | Recurring sessions |
| **Tailscale Funnel** | ACL-based, no built-in auth [r020] | P2P WireGuard mesh | ~5 min | Free for personal use | Both endpoints yours |

**Recommendation:** Cloudflare Tunnel + Access for recurring use (email OTP second factor, free tier, no third-party trust dependency). ngrok for quick one-off demos. Tailscale simplest if already installed but lacks its own auth layer beyond the dashboard token. [r010] [r022]

**Caveat:** Tunneling evidence is web-sourced only — no tested-tier claims. Verify before production deployment.

---

## Next Steps

### Build Now

- **Trust tier UI** — radio toggle for Paranoid / Standard / Autonomous in the dashboard. Wire to PreToolUse auto-approve logic. [r030] [r031]
- **Hybrid fail-safe hook** — add a local command hook that checks `curl -sf localhost:9090/health` before allowing tool calls. Exit code 2 = blocking deny. Closes the fail-open gap. [x010]
- **Notification hooks** — subscribe to Notification events for AskUserQuestion dialogs, session lifecycle, and error alerts. Display on dashboard even if not actionable yet. [r024]
- **updatedInput sandboxing** — strip `--force` flags or add `--dry-run` to Bash commands in Autonomous mode. [r032]

### Wait For

- **Claude Code API for text injection** — multiple GitHub issues request the ability to answer AskUserQuestion remotely (#13830, #15872, #20169). Until this ships, the additionalContext workaround is the best option. [r023]
- **Hot-reloadable hook config** — currently requires session restart to change which hooks are active. [r007]
- **Fail-closed HTTP hook mode** — a Claude Code setting to treat non-2xx as blocking errors rather than non-blocking. Would eliminate the need for the hybrid hook workaround. [x002]

---

*Claims hash 51751a2 — Compiled by Wheat*
