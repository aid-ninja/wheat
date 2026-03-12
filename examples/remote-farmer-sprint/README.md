# Remote Farmer Sprint

> How should we build a remote permission and monitoring dashboard for Claude Code?

## Outcome

A zero-dependency Node.js server (~650 LOC) that intercepts Claude Code's HTTP hooks and relays permission requests to a browser dashboard over SSE + polling fallback. Remote users approve/deny tool calls from their phone via Cloudflare Tunnel.

## Stats

- **56 claims** across 10 topics
- **8/10 topics** at tested evidence tier
- **0 npm dependencies**
- Full end-to-end verified: Mac → hooks → server → Cloudflare Tunnel → iPhone → approve/deny

## Key Findings

- Cloudflare quick tunnels buffer SSE — polling fallback required (p007)
- iOS Safari has no Notification API — must guard all references (p008)
- Trust tiers (paranoid/standard/autonomous) eliminate approval fatigue (p009)
- Empty JSON `{}` on 2xx = auto-allow in Claude Code — critical security footgun (x001)
- Notification hooks are fire-and-forget — can't relay user text input (r023)

## Structure

- `claims.json` — 56 typed claims with evidence tiers
- `prototypes/remote-dashboard/` — working server + dashboard
- `output/brief.html` — 8-slide architecture recommendation
- `research/` — hooks and permissions deep dive
