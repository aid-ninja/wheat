# Wheat — Research Sprint

> This file is auto-maintained by Wheat slash commands. Edit with care.

## Sprint

- **Question**: How can we build a live visualization of Wheat that teaches the framework by showing itself in action?
- **Audience**: Developer learning Wheat by using it
- **Constraints**: None — full creative freedom, self-contained HTML, must dogfood the pipeline
- **Phase**: define

## Connectors

_No connectors configured. Use `/connect` to link org tools._

## Conventions

### Claims System (Bran IR)
- All findings are tracked as typed claims in `claims.json`
- Every slash command that produces findings MUST append claims
- Every slash command that produces output artifacts MUST run `node wheat-compiler.js` first
- Output artifacts consume `compilation.json`, never `claims.json` directly
- The compiler is the enforcement layer — if it says blocked, no artifact gets produced

### Claim Types
- `constraint` — hard requirements, non-negotiable boundaries
- `factual` — verifiable statements about the world
- `estimate` — projections, approximations, ranges
- `risk` — potential failure modes, concerns
- `recommendation` — proposed courses of action
- `feedback` — stakeholder input, opinions, direction changes

### Evidence Tiers (lowest → highest)
1. `stated` — stakeholder said it, no verification
2. `web` — found online, not independently verified
3. `documented` — in source code, official docs, or ADRs
4. `tested` — verified via prototype or benchmark
5. `production` — measured from live production systems

### Claim ID Prefixes
- `d###` — define phase (from /init)
- `r###` — research phase (from /research)
- `p###` — prototype phase (from /prototype)
- `e###` — evaluate phase (from /evaluate)
- `f###` — feedback phase (from /feedback)

### Git Discipline
- Every slash command that modifies claims.json auto-commits
- Commit format: `wheat: /<command> <summary> — added/updated <claim IDs>`
- `git log --oneline claims.json` = the sprint event log
- Compilation certificate references the claims hash for reproducibility

### Output Artifacts
- HTML files are self-contained (inline CSS/JS, no external deps)
- Use the dark scroll-snap template for explainers and presentations
- Use the dashboard template for status and comparisons
- PDFs generated via `node build-pdf.js <file.md>`

### Directory Structure
- `research/` — topic explainers (HTML + MD)
- `prototypes/` — working proof-of-concepts
- `evidence/` — evaluation results and comparison dashboards
- `output/` — compiled artifacts (briefs, presentations, dashboards)
- `templates/` — HTML/CSS templates for artifact generation
