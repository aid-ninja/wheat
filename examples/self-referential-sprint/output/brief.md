---
pdf_options:
  format: A4
  margin: 25mm 20mm
css: |-
  body { font-family: system-ui, sans-serif; font-size: 11pt; line-height: 1.6; color: #111; max-width: 100%; }
  h1 { font-size: 20pt; margin-bottom: 4pt; }
  h2 { font-size: 14pt; margin-top: 16pt; margin-bottom: 6pt; border-bottom: 1px solid #ddd; padding-bottom: 4pt; }
  h3 { font-size: 12pt; margin-top: 12pt; margin-bottom: 4pt; }
  table { border-collapse: collapse; width: 100%; margin: 8pt 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: 4pt 8pt; text-align: left; }
  th { background: #f5f5f5; }
  .citation { font-size: 9pt; color: #666; }
  .certificate { margin-top: 24pt; padding: 12pt; background: #f9f9f9; border-radius: 4pt; font-size: 9pt; }
---

# Brief: How can we build a live visualization of Wheat that teaches the framework by showing itself in action?

**Date**: 2026-03-11
**Claims**: 156 total, 143 active, 4 superseded, 5 conflicted (2 resolved)
**Certificate**: sha256:150e17e
**Status**: BLOCKED (3 unresolved conflicts)

## Executive Summary

The sprint answered its question decisively: a zero-dependency Node.js server with SSE push, a timeline-first dashboard, and a replay viewer together form a self-referential teaching tool that demonstrates Wheat by being a product of it. All five original constraints are satisfied -- self-contained HTML works via file://, the dogfooding loop is confirmed, and WCAG 2.2 AA accessibility is verified. The compiler scales linearly to 1000+ claims in under 60ms. However, the sprint invested heavily in technical architecture (48 claims) while leaving pedagogy underexplored (13 claims, all from a single source). The visualization shows what happened but does not yet explain why -- it is a demo, not a tutorial. Addressing the pedagogy blind spot is the highest-priority next step.

## Key Findings

### Architecture -- tested (48 claims, 7 sources, 5/6 types)

The core architecture is validated and robust:

- **Zero-dependency server**: wheat-server.js is 133 lines with no npm dependencies. SSE auto-reconnect works natively. The server watches the directory (not the file) to survive atomic file replacements [p001, p002, p012, e008].
- **Compiler performance**: 7-pass pipeline compiles 1000 claims in 59ms. Linear scaling confirmed via benchmarks [e001, w010]. Conflict detection is O(n^2) but stays fast due to sparse conflict graphs.
- **Compiler capabilities**: v0.2.0 has 685 lines, 5 CLI modes (--summary, --check, --diff, --next, --scan), 9 pipeline passes, module.exports for library usage. Still zero dependencies [r014, r028, r036].
- **17-command suite** organized in 3 tiers: Sprint Lifecycle (10), Quality Assurance (4), Operations (3). Three feedback loops: self-correction, external validation, meta-learning [r013, r016].
- **Replay architecture**: Pre-computed frames extracted from git history, hybrid framing (commit-level primary, sub-frames for batches >3 claims), stateless render function. 35 frames expanded to ~50-60 with sub-framing [r042, p013, p016, e010].
- **Key risk**: Conflict detection relies on manual conflicts_with arrays -- no semantic conflict detection [x009]. The --next heuristic is static, not adaptive [r023].

### UX Pattern -- tested (25 claims, 5 sources, 5/6 types)

- **Timeline-first layout** with progressive disclosure: claims as expandable nodes grouped by phase, reverse-chronological, compact scoreboard [p006, f006].
- **Phase-colored visual system**: 5 distinct hues (amber/blue/green/purple/cyan) for instant visual grouping. Follows Atlassian's 5-7 hue best practice [p007, w007].
- **Replay viewer**: Four-panel layout (scrubber + claims + coverage + stats), play/pause/speed, keyboard shortcuts, milestone markers, CSS transitions for claim animations [p014, p017].
- **Known gaps**: No mobile/responsive design [r052]. No claim filtering for 50+ claim sprints [r027]. No sprint health composite indicator [r032]. Animation timing bugs at high playback speeds partially fixed [x016, p019].

### Accessibility -- tested (14 claims, 4 sources, 3/6 types)

- **WCAG 2.2 AA**: 13/13 applicable checks pass on the live dashboard. Five targeted fixes in ~25 lines: contrast ratio, semantic landmarks, keyboard support, aria-live, focus styles [p009, e004, r033].
- **Google Fonts removed**: Templates now use system font stack, eliminating external dependency [p010].
- **Gap**: Replay viewer has had no accessibility audit despite being the primary teaching artifact [r059]. No automated a11y testing in the pipeline [x008].

### Output Format -- tested (12 claims, 5 sources, 5/6 types)

- **Self-contained HTML verified**: All artifacts have zero external dependencies, work via file://, work offline [p008, e003].
- **Automated guard**: `node wheat-compiler.js --scan` checks all HTML for external URLs, exits 1 on violation [p011].
- **Multi-format output**: Same compilation.json feeds Markdown, PDF, HTML dashboard, and HTML presentation renderers [r038].
- **Replay file size**: 1.8MB uncompressed (corrected from 763KB estimate), but gzip-compressible to ~180KB. Delta encoding rejected as premature optimization [x020, x021, x022].

### Dogfooding -- tested (16 claims, 5 sources, 4/6 types)

- **Self-referential loop confirmed**: The dashboard visualizes its own sprint. As claims are added, the dashboard updates in real time [p005, e005, w005].
- **Git log as event stream**: Wheat commit format is machine-parseable, enabling sprint timeline reconstruction [r025].
- **Known biases**: Selection bias in evidence -- technical claims reach tested tier easily while UX claims stay at stated [x010]. Witness claims all confirmatory (15/15 non-contradictory), though this is partially by design [r055, x023-x027].

### Pedagogy -- web (13 claims, 1 source, 3/6 types) -- WARNING: echo chamber

This is the sprint's most significant blind spot. All pedagogy claims come from a single research pass:

- **The visualization shows what happened but not why** [r050]. No annotations explain Wheat concepts at key moments.
- **No learning objectives defined** [r049]. No worked-example scaffolding [r060]. No interactive sandbox [r068].
- **Recommendations exist**: Five learning objectives proposed [r064], contextual annotations designed [r065], three-act structure outlined [r066]. But none are prototyped or tested.
- **Tension**: Pedagogical scaffolding risks making the tool feel like a tutorial rather than a professional tool [r067].

### Quality -- tested (13 claims, 3 sources, 5/6 types)

- **Evidence tier system** maps to scientific method's evidence pyramid [r031]. /calibrate loop remains untested (no production data).
- **Compiler determinism**: Three determinism leaks found and fixed -- canonical JSON hashing, lexicographic tiebreak, compiled_at excluded from certificate [f009].
- **No automated tests**: Zero test suites for compiler, build tool, or server. Six-test minimal suite recommended [r053, r057].
- **Subjective quality bar**: "I'll know it when I see it" (d005) is unfalsifiable. Samurai Jack-themed presentation validated stakeholder taste but not rigor [f007, x007].

### Audience -- documented (3 claims, 2 sources, 3/6 types)

- Thin topic: only 3 claims. Target is a developer comfortable with Node.js and JSON [d003, r040].
- **No user testing**: The "self-explanatory without external docs" constraint (d003) is asserted but never validated [r051].

### Scope -- documented (3 claims, 2 sources, 3/6 types)

- Sprint expanded well beyond original question into compiler features, accessibility, presentations, and replay. Productive but would be risky under time constraints [r039].
- Velocity: ~10 artifacts, 17 commands, 153 claims in a single session [r034].

## Risks & Open Questions

**High severity:**
1. **Pedagogy gap** (r048-r050, r056): The visualization does not yet teach. No learning objectives, no annotations, no scaffolding. This directly undermines the sprint question.
2. **No automated tests** (r053, r057): 685-line compiler with 5 CLI modes and zero repeatable assertions. Silent regressions are inevitable.
3. **Replay viewer accessibility** (r059): Primary teaching artifact has no WCAG audit.

**Medium severity:**
4. **No user testing** (r051): Audience assumptions unvalidated.
5. **Confirmation bias in witnesses** (r055, x026): All external validation sought agreement.
6. **Manual conflict detection** (x009): Contradictory claims can coexist undetected.
7. **No mobile/responsive design** (r052): Desktop-only layouts.
8. **claims.json ergonomics** (r029): 153 claims = 3000+ lines of JSON, unwieldy for manual editing.

**Low severity / deferred:**
9. Compiler pipeline runs all passes even when early passes produce warnings [x006].
10. Scalability bottleneck shifts from compiler to I/O and rendering at 1000+ claims [x004].
11. Replay pacing still has batch-commit jumps despite hybrid framing [p015].
12. Git-based frame extraction requires repo at generation time [r047].

## Recommendations

**Immediate (ship-blocking):**
1. **Define learning objectives** for the replay viewer and add contextual annotations at key frames [r064, r065, r056].
2. **Add a minimal test suite** for wheat-compiler.js -- 6 tests covering happy path, error cases, and determinism [r057].
3. **Run WCAG audit on replay viewer** and apply the same 5-fix pattern that worked for the dashboard [r059, r021].

**Next sprint:**
4. Add claim filtering (topic, type, evidence tier) to the dashboard [r027].
5. Add a sprint health composite indicator [r032].
6. Implement compiler --watch mode for tighter dev feedback loop [r024].
7. Add constraint-aware coverage analysis to silence false-positive W_WEAK_EVIDENCE warnings [r012].
8. Include a cold-start example with seed claims for new users [r041].

**Future:**
9. Implement guided replay with three-act structure and sandbox mode [r066, r068].
10. Add mobile/responsive CSS [r052].
11. Add compiler --json-events for IDE/tooling integration [r035].
12. Support incremental/diff-aware briefs [r030].

## Blind Spots

Identified via /blind-spot analysis (r048-r059):

1. **Pedagogy**: The biggest gap. Sprint built the instrument but not the lesson plan.
2. **Audience validation**: No real users tested. Self-explanatory claim is an assumption.
3. **Mobile/responsive**: All layouts are desktop-only.
4. **Automated testing**: Zero test suites across all components.
5. **Witness confirmation bias**: External validation only sought agreement.
6. **Estimate gaps**: UX recommendations have no sizing -- stakeholders cannot prioritize.
7. **Replay viewer a11y**: Primary teaching artifact not audited.
8. **Error handling in build-replay.js**: Undefined behavior on corrupt git objects.

## Evidence Summary

| Tier | Count | % |
|------|-------|---|
| production | 0 | 0.0% |
| tested | 34 | 23.1% |
| documented | 25 | 17.0% |
| web | 75 | 51.0% |
| stated | 13 | 8.8% |

**Notes**: No claims have reached production tier (no real users yet). The high web percentage reflects extensive /witness corroboration passes. 34 tested claims span 5 of 9 topics. The 13 stated claims are predominantly constraints and feedback -- their natural and correct tier.

## Appendix: Superseded Claims

| ID | Original claim | Superseded by | Reason |
|----|---------------|---------------|--------|
| r001 | Use SSE server as primary architecture | f001 | Stakeholder prefers static HTML; SSE is dev-only tool |
| p004 | fs.watch fires reliably on macOS | e007 | fs.watch dies on atomic file replacement (inode change) |
| x014 | Claim-level framing for replay | x015 | Hybrid framing preserves git fidelity while solving pacing |
| x018 | Replay.html is ~763KB | x020 | Actual size is 1.8MB after hybrid sub-framing |

## Appendix: Resolved Conflicts

| Risk | Resolution | Outcome |
|------|-----------|---------|
| x012: Uneven replay pacing | e010: Hybrid framing adopted | Batch commits >3 claims auto-split into sub-frames |
| x013: Batch commits conflate narrative | e010: Hybrid framing adopted | Sub-frames grouped by topic for coherence |

<div class="certificate">

**Compilation Certificate**
Compiler: Wheat v0.2.0 | Claims hash: 150e17e | Status: BLOCKED | Errors: 3 (E_CONFLICT: r055/x023, r055/x024, r049/r064)
Unresolved conflicts must be resolved via /resolve before shipping.
</div>
