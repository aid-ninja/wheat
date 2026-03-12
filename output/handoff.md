---
pdf_options:
  format: A4
  margin: 25mm 20mm
css: |-
  body { font-family: system-ui, sans-serif; font-size: 11pt; line-height: 1.6; color: #111; max-width: 100%; }
  h1 { font-size: 20pt; margin-bottom: 4pt; }
  h2 { font-size: 14pt; margin-top: 16pt; margin-bottom: 6pt; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 4pt 8pt; text-align: left; }
  th { background: #f5f5f5; }
  .citation { font-size: 9pt; color: #666; }
  .certificate { margin-top: 24pt; padding: 12pt; background: #f9f9f9; border-radius: 4pt; font-size: 9pt; }
---

# Sprint Handoff: Scaling Remote Farmer

**Date**: 2026-03-12  |  **Claims hash**: ddef041  |  **Compilation**: ready (0 errors, 2 warnings)

---

## Sprint Summary

**Question**: How should we scale Remote Farmer for multi-session and multi-sprint support, and what repo cartography system keeps AI model interactions fast as the Wheat codebase and git history grow?

**Status**: Near-complete. 9 of 11 roadmap items are DONE. Two remain (estimated 2-2.5 hours).

**Key findings**:
- Multi-session works via session-keyed Maps with lazy initialization from hook payloads [p003]
- Multi-sprint works via sprints/ directory scanning with hot-reload [p004]
- Repo cartography works via compiler-generated topic-map manifest (<10ms, ~6KB) [p001, p007]
- Security hardening is comprehensive: cookie auth, CORS, CSRF, token rotation, WebSocket transport [p005, p009, p010]
- State persistence uses atomic JSON snapshots with graceful shutdown [p008]
- Backwards compatibility verified: 10/10 automated tests pass [p006]

**Audience**: Solo developer scaling to team use

**Constraints**: Zero npm dependencies (Node built-in only), must not slow existing single-session workflow

---

## Architecture Overview

### How the pieces fit together

```
Claude Code Session(s)
    |
    | HTTP hook payloads (include session_id UUID)
    v
server.mjs (Remote Farmer)
    |--- SessionState Map (per-session pending, trust, rules, activity)
    |--- Sprint scanner (--sprints-dir, fs.watchFile hot-reload)
    |--- .farmer-state.json (atomic persistence, 30s auto-save)
    |--- Cookie auth + CSRF tokens
    |
    |--- SSE stream (/api/stream)
    |--- WebSocket (/ws upgrade) -- CF tunnel compatible
    |--- REST API (/api/state, /api/sprints, /api/decide, etc.)
    v
dashboard.html (Browser)
    |--- Session pill-bar switcher + color coding
    |--- Sprint selector dropdown
    |--- Real-time permission approval/denial
    |--- Cascade transport: WebSocket > SSE > 2s polling

wheat-compiler.js
    |--- claims.json -> compilation.json (9-pass pipeline)
    |--- generate-manifest.js -> wheat-manifest.json (topic map)
    |
    v
Output artifacts (brief, dashboard, presentation, replay -- all self-contained HTML)
```

### Transport cascade

The dashboard uses a three-tier fallback for real-time updates:
1. **WebSocket** (works through Cloudflare quick tunnels) -- ws.mjs, ~120 LOC, RFC 6455
2. **SSE** (works local/direct, broken through CF quick tunnels)
3. **2s polling** (/api/state) -- always active as baseline

### Data flow

1. All findings become typed claims in `claims.json`
2. `wheat-compiler.js` validates and compiles into `compilation.json`
3. The compiler also runs `generate-manifest.js` to produce `wheat-manifest.json`
4. All output artifacts consume `compilation.json`, never `claims.json` directly
5. The manifest is a topic-map index: AI tools can read one file instead of 3-5 Glob/Grep calls

---

## What's Built and Working

### Prototypes (10 completed)

| ID | Prototype | What it proves |
|----|-----------|---------------|
| p001 | Manifest generator | Topic-map in <10ms, ~5.8KB, single Read replaces 3-5 searches |
| p003 | Multi-session | SessionState class, session-keyed Maps, SSE tagging, pill-bar UI |
| p004 | Multi-sprint | Sprint scanning, /api/sprints, hot-reload, backwards compat |
| p005 | Security hardening | Cookie auth (HttpOnly, SameSite=Strict), CORS restriction, Referrer-Policy |
| p006 | Backwards compat | 10/10 automated tests: token auth, cookie auth, SSE, hook fallback |
| p007 | Compiler manifest | generate-manifest.js wired into compiler, non-fatal on failure |
| p008 | State persistence | Atomic JSON writes, SIGTERM/SIGINT graceful shutdown, 30s auto-save |
| p009 | WebSocket transport | RFC 6455 handshake, cascade fallback, 30s ping/pong, CF tunnel proof |
| p010 | CSRF + rotation | Per-session CSRF tokens, auto-rotation, grace period, timing-safe |
| p011 | WebSocket hardening | Validates binary frame rejection, oversized frame handling |

### Claim inventory

- **74 total claims** (66 active, 2 superseded, 6 challenge/witness)
- **9 topics**: multi-session (20), security (14), cartography (9), multi-sprint (8), performance (6), state-persistence (6), compatibility (2), reliability (2), websocket-hardening (1)
- **Evidence tiers**: documented (41), tested (12), stated (10), web (3)
- **All topics at "tested" evidence level**

---

## Known Risks and Open Items

### Unresolved: f001 -- config vs git-derived state

Stakeholder feedback says config files should not duplicate git-derivable state. The original recommendations (r020: sprints/ directory with config pointer, r025: config pointer over symlinks) are superseded. The active sprint can potentially be inferred from directory scanning or git log recency rather than an explicit pointer in `wheat.config.json`. Resolution needed before production.

### Compiler warnings

- **W_TYPE_MONOCULTURE on "reliability"**: Only risk claims (x006, x009). Needs factual/recommendation claims.
- **W_TYPE_MONOCULTURE on "websocket-hardening"**: Only one factual claim (p011). Minor topic, may not need expansion.

### Risks to monitor

| Risk | Severity | Status |
|------|----------|--------|
| Approval confusion with concurrent sessions [r006] | Medium | Mitigated by session labels + colors |
| SSE broken through CF quick tunnels [r027] | High | Mitigated by WebSocket fallback [p009] |
| Full compromise on token leak [r031] | High | Mitigated by cookie auth [p005] + rotation [p010] |
| /api/ask injection [r032] | Medium | Mitigated by CSRF tokens [p010] |
| Manifest can mislead if stale [r014] | Low | Mitigated by compiler-generated updates [p007] |
| No rate limiting on token attempts [r033] | Low | 128-bit entropy makes brute force infeasible |

### Lifecycle hook limitations

- SessionStart fires on resume/clear/compact, not just new sessions [w001]
- Lifecycle hooks are command-only, not HTTP -- requires curl wrapper pattern [w002]

---

## How to Pick This Up

### Prerequisites

- Node.js (any recent version with ESM support)
- The Wheat repo at `/Users/aid.idrizovic/repo/wheat`
- Claude Code (for the hook integration and slash commands)

### Step 1: Verify the build

```bash
cd /Users/aid.idrizovic/repo/wheat

# Compile claims and verify status
node wheat-compiler.js --summary

# Should show: Status: READY, 74 claims, 9 topics
```

### Step 2: Understand the current state

Read these files in order:
1. `CLAUDE.md` -- the operating manual (intent router, claims system, conventions)
2. `output/brief.md` -- the decision brief (what we recommend and why)
3. `wheat-manifest.json` -- the topic map (what's where, which files matter)
4. This file (`output/handoff.md`) -- the full context

### Step 3: Run the prototype

```bash
# Start the Remote Farmer server
node prototypes/remote-dashboard/server.mjs --port 9090

# It prints a URL with auth token. Open in browser.
# Configure Claude Code hooks to point at the server (see hooks-config.json)
```

### Step 4: Remaining work

**Item 1: Named Cloudflare tunnel** (~2h)
- Replace `cloudflared tunnel --url` (quick tunnel) with a named tunnel for stable subdomain
- This enables native SSE support (no WebSocket fallback needed)
- Reference: r027, r036

**Item 2: Sprint pointer resolution** (~0.5h)
- Decide: does the active sprint come from `wheat.config.json` or git-derived detection?
- The f001 feedback argues for git-derived. Implement whichever approach is chosen.
- Reference: f001 vs r020/r025

### Step 5: Use Wheat slash commands

All work in this repo routes through slash commands:
- `/research <topic>` -- gather information, creates claims
- `/prototype <name>` -- build and validate, creates tested claims
- `/challenge <id>` -- stress-test a claim
- `/brief` -- compile a decision document
- `/status` -- see where the sprint stands

---

## Key Files and Their Purpose

### Root

| File | Purpose |
|------|---------|
| `CLAUDE.md` | AI operating manual: intent router, claims system, conventions |
| `claims.json` | Canonical data store: 74 typed claims with evidence and conflict tracking |
| `compilation.json` | Compiler output consumed by all artifacts (never edit directly) |
| `wheat-compiler.js` | 9-pass compiler: validate, types, sort, conflicts, resolve, coverage, readiness, certificate, output |
| `generate-manifest.js` | Topic-map manifest generator (<10ms, invoked by compiler) |
| `wheat-manifest.json` | Topic map: topics -> claims -> files, for fast AI search |
| `wheat.config.json` | Sprint config: current sprint pointer, directory layout |
| `wheat-init.js` | Sprint initializer: seeds claims.json with define-phase constraints |
| `wheat-guard.js` | Git pre-commit hook: ensures compilation before artifact commits |
| `build-pdf.js` | PDF generator from markdown |
| `build-replay.js` | Replay viewer builder: extracts git history into pre-computed frames |

### Prototype (prototypes/remote-dashboard/)

| File | Purpose |
|------|---------|
| `server.mjs` | The main Remote Farmer server (~1000 LOC). Multi-session, multi-sprint, auth, persistence, SSE, REST API |
| `dashboard.html` | Browser dashboard: session switcher, sprint selector, permission approval, real-time updates |
| `ws.mjs` | WebSocket server (~150 LOC). RFC 6455 text frames, ping/pong, zero deps |
| `hooks-config.json` | Example Claude Code hooks configuration pointing at the server |
| `manifest.json` | Example manifest for the dashboard's sprint view |
| `MULTI-SESSION-PLAN.md` | Design document for multi-session refactor |
| `sw.js` | Service worker (offline support placeholder) |

### Output (output/)

| File | Purpose |
|------|---------|
| `brief.md` / `brief.html` / `brief.pdf` | Decision brief for stakeholders |
| `dashboard.html` | Sprint status dashboard |
| `presentation.html` | Dark scroll-snap presentation slides |
| `replay.html` | Interactive sprint replay viewer |
| `handoff.md` / `handoff.html` | This handoff package |

### Other directories

| Directory | Purpose |
|-----------|---------|
| `research/` | Topic explainers (HTML + MD) |
| `evidence/` | Evaluation results |
| `templates/` | HTML/CSS templates for artifact generation |
| `test/` | Test scripts |
| `examples/` | Archived sprints (remote-farmer-sprint, self-referential-sprint) |
| `docs/` | Documentation artifacts |

---

## Remaining Work Estimate

| Item | Effort | Priority |
|------|--------|----------|
| Named Cloudflare tunnel (stable subdomain + native SSE) | ~2h | Medium (WebSocket fallback reduces urgency) |
| Sprint pointer resolution (f001) | ~0.5h | Low (functional without it) |
| Reliability topic diversification (W_TYPE_MONOCULTURE) | ~0.5h | Low (compiler warning only) |
| **Total** | **~3h** | |

The sprint is production-ready for single-session use today. Multi-session and multi-sprint features are prototyped and tested but not yet integrated into the main Farmer workflow.

---

## Wheat Framework Quick Reference

For someone new to Wheat:

1. **Claims** are the atomic unit. Every finding is a claim with a type (factual, risk, recommendation, constraint, estimate, feedback) and evidence tier (stated < web < documented < tested < production).

2. **The compiler** (`wheat-compiler.js`) validates claims, detects conflicts, checks coverage, and produces `compilation.json`. All artifacts read from compilation.json.

3. **Slash commands** are the workflow. Each command appends claims and triggers compilation. `git log --oneline claims.json` is the sprint event log.

4. **The pipeline**: question -> claims -> compiler -> compilation -> artifacts. Every step is traceable via the compilation certificate (includes claims hash).

5. **Conflict resolution** is explicit. `/challenge` creates conflicts, `/resolve` picks winners. Superseded claims stay with `status: "superseded"`.

---

<div class="certificate">
Generated by /handoff on 2026-03-12. Claims hash: ddef041. Compiler: wheat v0.2.0. Claims: 74 (66 active, 2 superseded). Compilation status: ready.
</div>
