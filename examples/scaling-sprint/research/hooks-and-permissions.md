# Claude Code Hooks & Permission System — Research

## Key Finding

Claude Code has **native HTTP hooks** that can intercept permission requests and relay them to a local web server. This is the entire integration surface needed for a remote permission dashboard — no patching required.

## How It Works

### Hook Events (18 total, 4 critical for us)

| Hook | When | Blocking? | Use Case |
|------|------|-----------|----------|
| `PreToolUse` | Before permission check | Yes | Pre-filter, auto-allow safe tools |
| `PermissionRequest` | When dialog would appear | Yes | Remote approve/deny |
| `PostToolUse` | After successful execution | No | Activity feed |
| `PostToolUseFailure` | After failed execution | No | Error tracking |

### HTTP Hook Configuration

```json
{
  "hooks": {
    "PermissionRequest": [{
      "matcher": "*",
      "hooks": [{
        "type": "http",
        "url": "http://localhost:9090/hooks/permission",
        "timeout": 120,
        "headers": { "Authorization": "Bearer $DASHBOARD_TOKEN" },
        "allowedEnvVars": ["DASHBOARD_TOKEN"]
      }]
    }],
    "PostToolUse": [{
      "matcher": "*",
      "hooks": [{
        "type": "http",
        "url": "http://localhost:9090/hooks/activity",
        "timeout": 5
      }]
    }]
  }
}
```

### Hook Input (POST body from Claude Code)

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "rm -rf /tmp/build" },
  "tool_use_id": "id-xyz",
  "permission_suggestions": [...]
}
```

### Hook Response (dashboard → Claude Code)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "message": "Approved via remote dashboard"
    }
  }
}
```

## Architecture

```
Claude Code CLI
  ├── PermissionRequest hook → POST localhost:9090/hooks/permission
  ├── PostToolUse hook → POST localhost:9090/hooks/activity
  └── PostToolUseFailure hook → POST localhost:9090/hooks/activity

Dashboard Server (Node.js, localhost:9090)
  ├── Receives hook POSTs, holds pending requests
  ├── WebSocket push to browser
  ├── fs.watch on claims.json for sprint state
  └── Tunneled via ngrok/cloudflare for remote access

Browser Dashboard
  ├── Permission queue (approve/deny buttons)
  ├── Live activity feed
  ├── Claim tree visualization
  └── Sprint status dashboard
```

## Critical Risks

1. **Timeout pressure** — Default 30s for HTTP hooks. Human on mobile needs more time. Set to 120-300s, but this stalls Claude Code.
2. **Fallthrough on failure** — If dashboard is down, non-2xx = non-blocking error = falls through to local terminal. Good for resilience, but means a down dashboard doesn't block dangerous actions.
3. **No hot-reload** — Hook config loaded at session start. Can't dynamically change which tools need approval mid-session.
4. **Security of hook config** — .claude/settings.json with hook URLs is a security-sensitive file (CVE-2025-59536).

## Tunneling Comparison

| Option | Auth | Trust | Setup | Best For |
|--------|------|-------|-------|----------|
| ngrok + --auth | Basic auth | Routes through ngrok infra | 1 min | Quick demos |
| Cloudflare Tunnel | Email OTP, Zero Trust | Your own CF account | 5 min | Multi-hour sessions |
| Tailscale | ACL-based | P2P WireGuard | 5 min | Both endpoints are yours |

## Prior Art

Community projects (claude-code-server, claude-code-webui, CloudeCode) wrap Claude Code as subprocess. None use HTTP hooks for remote permission delegation — our approach would be novel.

## Claims

r001–r015 (see claims.json)
