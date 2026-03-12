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

# Decision Brief: Scaling Remote Farmer for Multi-Session, Multi-Sprint, and Repo Cartography

**Date**: 2026-03-12  |  **Audience**: Solo developer, team leads  |  **Phase**: Compiled

## Executive Summary

Remote Farmer should scale via three independent workstreams: (1) session-keyed server state with `Map<session_id, SessionState>` for multi-session support (r003, p003), (2) a `sprints/` directory model with `wheat.config.json` pointer for multi-sprint (r020, r025, p004), and (3) a compiler-generated topic-map manifest for repo cartography (r011, r017, p001). All three prototypes are built and tested. The manifest generator produces results in <10ms (p001). Total implementation effort: 5-9 hours across all workstreams (r008, r026).

## Recommendation

### Multi-Session (13 claims, tested evidence)

Use a single-server, session-keyed architecture (r003). Replace global singletons with a `Map<session_id, SessionState>` and a `getSession(id)` lazy initializer (r004). Claude Code's hook payloads already include a stable `session_id` UUID (r001), and SessionStart/SessionEnd lifecycle hooks provide explicit session boundaries (r002, w001).

**Critical constraint**: SessionStart/SessionEnd only support command-type hooks, not HTTP (w002) -- a curl wrapper is required for Farmer integration.

**Prototype validated**: SessionState class, session-keyed Maps, SSE tagging, and pill-bar session switcher with hue-from-hash color coding are implemented and tested (p003). Backwards compatible with single-session via 'default' fallback.

Dashboard UX: unified feed with session color-coding, pill-bar session switcher (r005, p002). Permission cards must prominently display session labels to mitigate cross-session approval confusion (r006). Heartbeat timeout (5min) for crashed sessions (r007). Estimated effort: 2-4 hours (r008).

### Multi-Sprint (9 claims, tested evidence)

Use a `sprints/` directory with one subdirectory per sprint, each self-contained (r020). The current sprint pointer lives in `wheat.config.json` (not symlinks) for cross-platform portability (r025, resolved against r020). Dashboard shows a collapsible sprint card list for switching (r022). Cross-sprint claim references use `sprint-slug:claim-id` format (r024). Server adds `--sprints-dir` flag with hot-reload via `fs.watchFile` (r021).

**Prototype validated**: Sprint scanning, `/api/sprints` endpoint, hot-reload, and backwards-compatible `--claims` flag are implemented and tested (p004).

Sprint lifecycle: `/init` creates under `sprints/`, archiving sets `meta.phase` to 'archived' (r023). Estimated effort: 3-5 hours (r026).

### Repo Cartography (8 claims, tested evidence)

Generate `wheat-manifest.json` as a topic map on every compilation (r011, r017). The manifest maps topics to claim IDs, file paths, and sprints -- enabling a single `Read` call to replace 3-5 iterative Glob/Grep searches (r012). CLAUDE.md remains the behavioral instruction layer; the manifest handles structural discovery (r015). Commit messages should include `[topic]` tags for fast `git log --grep` (r014).

**Prototype validated**: Generator built and tested at <10ms, ~5KB output (p001).

**Cartography is needed now**: the repo has 157 files (x001), not 80 as previously estimated (r016 challenged). The `examples/` directory creates 62 duplicate-named files causing search noise (x002). Context window pollution -- not I/O time -- is the real cost metric (x003).

### Compatibility

Zero npm dependencies constraint maintained (d004). All implementations use Node built-in modules only. Single-session workflow preserved via backwards-compatible defaults.

## Evidence Summary

| Topic | Claims | Max Evidence | Sources | Types | Key Finding |
|-------|--------|-------------|---------|-------|-------------|
| multi-session | 13 | tested | 4 | 5/6 | SessionState Maps + session_id routing, prototype working (p003) |
| multi-sprint | 9 | tested | 3 | 5/6 | sprints/ dir + config pointer, prototype working (p004) |
| cartography | 8 | tested | 4 | 4/6 | Manifest generator built, <10ms, 5KB (p001) |
| performance | 6 | tested | 4 | 4/6 | 157 files now, context pollution is real cost (x001-x003) |
| compatibility | 1 | stated | 1 | 1/6 | Zero deps constraint, not independently verified |

## Tradeoffs and Risks

| Risk | Evidence | Mitigation |
|------|----------|------------|
| Concurrent permission confusion across sessions (r006) | stated | Color-coded session labels, distinct hue per session_id |
| CLAUDE.md staleness if used for structural cartography (r015) | documented | Use manifest as structural truth, CLAUDE.md for behavior only |
| Symlink portability on Windows (r025) | documented | Config file as canonical pointer, symlinks as convenience only |
| SessionStart/SessionEnd command-only hooks (w002) | documented | Curl wrapper scripts instead of direct HTTP hooks |
| Context window pollution from noisy search results (x003) | documented | Manifest eliminates iterative search, saves 10-40K tokens/session |

## Blind Spots (from /blind-spot analysis)

- **Security**: No claims address attack vectors for Farmer exposed via Cloudflare Tunnel
- **Dashboard UX**: UX decisions scattered across topics, no dedicated risk analysis
- **Compatibility**: Single constraint claim (d004), never independently tested
- **Corroboration**: Zero claims have independent corroboration from a second source

## Resolved Conflicts

**r020 vs r025** (multi-sprint): r020 recommended symlinks for current-sprint pointer. r025 identified Windows portability risk. Resolution: use `wheat.config.json` `currentSprint` field as canonical pointer; symlinks optional as local convenience, not committed to git. Both claims remain active with complementary guidance.

## Implementation Roadmap

| Phase | Workstream | Effort | Status | Files |
|-------|-----------|--------|--------|-------|
| 1 | Manifest generator | -- | DONE (p001) | generate-manifest.js |
| 2 | Multi-session server refactor | 2-4h (r008) | DONE (p003) | server.mjs, dashboard.html |
| 3 | Multi-sprint support | 3-5h (r026) | DONE (p004) | server.mjs, dashboard.html, wheat-init.js, wheat-compiler.js |
| 4 | Compiler manifest integration | 1h | TODO | wheat-compiler.js |

## Appendix: Claim Inventory

| ID | Type | Topic | Evidence | Content |
|----|------|-------|----------|---------|
| d001 | constraint | multi-session | stated | Multi-session dashboard support required |
| d002 | constraint | multi-sprint | stated | Multi-sprint viewing and switching required |
| d003 | constraint | cartography | stated | Repo must be self-describing for AI sessions |
| d004 | constraint | compatibility | stated | Zero npm deps, backwards compatible |
| d005 | constraint | performance | stated | Measurably faster search with cartography |
| r001 | factual | multi-session | documented | session_id UUID in all hook payloads |
| r002 | factual | multi-session | documented | SessionStart/SessionEnd lifecycle hooks |
| r003 | recommendation | multi-session | documented | Single-server, session-keyed Maps |
| r004 | recommendation | multi-session | documented | getSession(id) lazy initializer |
| r005 | recommendation | multi-session | documented | Unified feed with session color-coding |
| r006 | risk | multi-session | stated | Concurrent permission confusion |
| r007 | factual | multi-session | documented | Heartbeat timeout for stale sessions |
| r008 | estimate | multi-session | stated | ~300 lines, 2-4 hours |
| r010 | factual | cartography | documented | CLAUDE.md auto-loads per directory |
| r011 | recommendation | cartography | documented | wheat-manifest.json topic map |
| r012 | factual | performance | documented | Single Read replaces 3-5 tool calls |
| r013 | recommendation | cartography | documented | Sprint index in compilation output |
| r014 | recommendation | cartography | documented | [topic] tags in commit messages |
| r015 | risk | cartography | documented | Per-directory CLAUDE.md staleness |
| r016 | estimate | performance | stated | Crossover at 150-200 files (CHALLENGED by x001) |
| r017 | recommendation | cartography | documented | Topic map over file tree |
| x001 | factual | performance | tested | Repo already 157 files, not 80 |
| x002 | factual | performance | tested | examples/ creates 62 duplicate-name files |
| x003 | risk | performance | documented | Context pollution is real cost, not I/O |
| w001 | factual | multi-session | documented | SessionStart/SessionEnd confirmed with source field |
| w002 | factual | multi-session | documented | Lifecycle hooks are command-only, not HTTP |
| r020 | recommendation | multi-sprint | documented | sprints/ directory + config pointer |
| r021 | recommendation | multi-sprint | documented | --sprints-dir flag with hot-reload |
| r022 | recommendation | multi-sprint | documented | Collapsible card list sprint switcher |
| r023 | recommendation | multi-sprint | documented | /init creates under sprints/, phase-based lifecycle |
| r024 | recommendation | multi-sprint | documented | Cross-sprint refs: sprint-slug:claim-id |
| r025 | risk | multi-sprint | documented | Symlink portability, use config instead |
| r026 | estimate | multi-sprint | stated | ~250 lines, 3-5 hours |
| p001 | factual | cartography | tested | Manifest generator: <10ms, 5KB topic map |
| p002 | recommendation | multi-session | documented | Multi-session refactor plan with SessionState |
| p003 | factual | multi-session | tested | Multi-session prototype implemented and working |
| p004 | factual | multi-sprint | tested | Multi-sprint prototype implemented and working |

---
<div class="certificate">
Compilation certificate: sha256:ae441976e7a83 | Compiler: wheat v0.2.0 | Claims: 37 | Compiled: 2026-03-12T07:52:28.621Z
</div>
