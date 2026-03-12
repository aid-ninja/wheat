# Evidence Gap Analysis — Addressing Weak Coverage Warnings

## The Problem

The Wheat compiler flags 4 topics with `W_WEAK_EVIDENCE` warnings:
- `output-format` — web (3 claims: d002, r007, f002)
- `audience` — stated (1 claim: d003)
- `scope` — stated (1 claim: d004)
- `quality` — stated (2 claims: d005, f004)

## Analysis: Real Gaps vs. False Alarms

### False alarms: audience, scope, quality

These topics consist entirely of **constraints** and **feedback** — claims whose natural evidence tier is `stated`. You can't upgrade "target audience is developers" to `tested` because it's a stakeholder decision, not a testable hypothesis.

The compiler treats all topics the same, but constraint-heavy topics will always show as "weak" because their evidence ceiling is `stated` by design. This is a **compiler design gap**, not a research gap.

**Recommendation**: The compiler should exempt `constraint` and `feedback` type claims from weak evidence warnings, or have a separate "constraint coverage" metric that checks for completeness rather than evidence tier.

### Real gap: output-format

This topic has:
- d002 (constraint/stated): "Must be self-contained HTML"
- r007 (risk/web): "Server vs static tension"
- f002 (feedback/stated): "Static HTML is the right call"

The risk claim r007 is the one dragging evidence to `web`. This *can* be upgraded: we can test that the output HTML actually works as self-contained (no external deps, opens in file://, works offline).

**Recommendation**: Run `/prototype` to test output-format constraints. Open output/dashboard.html in a browser via file://, verify no network requests, confirm all CSS/JS is inline. This produces `tested` evidence.

## Compiler Improvement Proposal

### Current behavior
```
status = 'weak' if max_evidence < documented (tier 3)
status = 'moderate' if max_evidence >= documented
status = 'strong' if max_evidence >= tested (tier 4)
```

### Proposed behavior
For topics where >50% of claims are type `constraint` or `feedback`:
- Don't emit W_WEAK_EVIDENCE
- Instead emit W_CONSTRAINT_ONLY if the topic has zero non-constraint claims
- This acknowledges that constraints are "weak" by definition but not a gap

## Action Items

1. **output-format**: Upgrade via prototype testing (verify self-contained HTML works)
2. **audience/scope/quality**: Accept as inherently stated-level; consider compiler improvement to reduce noise
3. **Compiler**: Consider adding constraint-aware coverage analysis (r009)
