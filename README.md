# Wheat

Research-driven development framework powered by Bran compilation. Wheat turns messy research into structured, evidence-graded claims that compile into decision-ready artifacts.

## What It Does

Wheat gives you a structured workflow for technical research sprints. Instead of ad-hoc notes and gut feelings, every finding becomes a **typed claim** with an **evidence tier**. A compiler validates the claim set, detects conflicts, and gates output artifacts on data integrity.

The core loop: **define** → **research** → **prototype** → **evaluate** → **ship**.

## Quick Start

### Install into an existing repo

```bash
# Standard: compiler + commands + guard hook
node wheat-init.js /path/to/your/repo

# Full: + templates, directories, build-pdf
node wheat-init.js --full /path/to/your/repo

# Headless: compiler + empty claims.json only
node wheat-init.js --headless /path/to/your/repo
```

### Start a sprint

```
/init       # Interactive — sets question, audience, constraints
/research   # Deep dive on a topic → claims + HTML explainer
/prototype  # Build something testable → upgrades evidence to "tested"
/evaluate   # Compare options against claims
/brief      # Compile the decision document
```

### Check status anytime

```
/status     # Dashboard with phase progress, coverage, conflicts
```

## The Claims System (Bran IR)

Every finding is a claim in `claims.json`:

```json
{
  "id": "r001",
  "type": "factual",
  "topic": "auth-providers",
  "content": "Auth0 serves 15,000+ customers as of 2025",
  "source": { "origin": "research", "artifact": "research/auth.md" },
  "evidence": "web",
  "status": "active",
  "phase_added": "research",
  "conflicts_with": [],
  "tags": ["pricing"]
}
```

### Claim Types

| Type | Purpose |
|------|---------|
| `constraint` | Hard requirements, non-negotiable boundaries |
| `factual` | Verifiable statements about the world |
| `estimate` | Projections, approximations, ranges |
| `risk` | Potential failure modes, concerns |
| `recommendation` | Proposed courses of action |
| `feedback` | Stakeholder input, opinions, direction changes |

### Evidence Tiers (lowest → highest)

| Tier | Level | Meaning |
|------|:-----:|---------|
| `stated` | 1 | Stakeholder said it, no verification |
| `web` | 2 | Found online, not independently verified |
| `documented` | 3 | In source code, official docs, or ADRs |
| `tested` | 4 | Verified via prototype or benchmark |
| `production` | 5 | Measured from live production systems |

When claims conflict, the compiler auto-resolves in favor of the higher evidence tier.

### Claim ID Prefixes

| Prefix | Source Command |
|--------|---------------|
| `d###` | `/init` (define phase) |
| `r###` | `/research` |
| `p###` | `/prototype` |
| `e###` | `/evaluate` |
| `f###` | `/feedback` |
| `x###` | `/challenge` |
| `w###` | `/witness` |
| `cal###` | `/calibrate` |
| `burn-###` | `/control-burn` (synthetic, always rejected by compiler) |

## Command Suite (17 Commands, 3 Tiers)

### Tier 1: Sprint Lifecycle

The core pipeline from question to decision.

| Command | Role |
|---------|------|
| `/init` | Bootstrap sprint — set question, audience, constraints |
| `/research` | Deep dive on a topic → HTML explainer + claims |
| `/prototype` | Build and test → upgrades evidence to `tested` |
| `/evaluate` | Test claims against reality, compare options |
| `/feedback` | Incorporate stakeholder input |
| `/resolve` | Manually adjudicate conflicts between claims |
| `/status` | Render the sprint dashboard |
| `/brief` | Compile the decision document |
| `/present` | Generate a presentation from compiled claims |
| `/connect` | Link external data sources (GitHub, Jira, etc.) |

### Tier 2: Quality Assurance

Stress-test the claim set's integrity, completeness, and accuracy.

| Command | Role |
|---------|------|
| `/challenge` | Devil's advocacy — finds counter-evidence, creates `x###` claims |
| `/blind-spot` | Structural gap analysis — dependency gaps, type monoculture, echo chambers |
| `/witness` | External corroboration — targeted URL-based verification (`w###` claims) |
| `/calibrate` | Score predictions vs outcomes — validates the framework itself (`cal###` claims) |

### Tier 3: Operations

Multi-sprint, multi-person, and historical workflows.

| Command | Role |
|---------|------|
| `/replay` | Time-travel through sprint evolution via git history |
| `/handoff` | Package sprint for knowledge transfer to a successor |
| `/merge` | Combine claim sets across independent sprints |

## The Compiler

`wheat-compiler.js` (v0.2.0) — a 7-pass pipeline that validates, resolves, and compiles claims.

### Usage

```bash
node wheat-compiler.js              # Compile → compilation.json
node wheat-compiler.js --summary    # Compile + print human-readable summary
node wheat-compiler.js --check      # Compile + exit non-zero if blocked
node wheat-compiler.js --gate       # Staleness check + readiness gate
node wheat-compiler.js --input X --output Y   # Compile arbitrary claims file
node wheat-compiler.js --diff A B   # Diff two compilation.json files
```

### Compilation Passes

1. **Validate** — schema checks on every claim (required fields, valid types/tiers)
2. **Conflict detection** — finds claims with `conflicts_with` references
3. **Auto-resolve** — higher evidence tier wins; same-tier conflicts need manual `/resolve`
4. **Coverage analysis** — per-topic stats: claim count, evidence ceiling, source diversity, type diversity, constraint ratio
5. **Corroboration** — tracks `witnessed_claim` support relationships
6. **Readiness check** — are there unresolved conflicts? Constraint-aware warnings (`W_CONSTRAINT_ONLY` vs `W_WEAK_EVIDENCE`)
7. **Output** — writes `compilation.json` with certificate (claims hash, timestamp, status)

### Configuration

`wheat.config.json`:

```json
{
  "dirs": {
    "output": "output",
    "research": "research",
    "prototypes": "prototypes",
    "evidence": "evidence",
    "templates": "templates"
  },
  "compiler": {
    "claims": "claims.json",
    "compilation": "compilation.json"
  }
}
```

### Library Usage

The compiler exports functions for programmatic use:

```js
const { compile, diffCompilations } = require('./wheat-compiler');
```

## Guard System

`wheat-guard.js` is a Claude Code `PreToolUse` hook that enforces compilation discipline:

- Blocks writes to `output/` unless `compilation.json` exists, is fresh, and status is `"ready"`
- Blocks writes to `claims.json` that skip required fields
- Exit code 0 = allow, exit code 2 = block (with reason on stderr)

Configured automatically by `wheat-init.js` in `.claude/settings.local.json`.

## Live Dashboard

A real-time browser dashboard served via SSE (Server-Sent Events).

```bash
node prototypes/live-dashboard/wheat-server.js [port]
# Default: http://localhost:3141
```

- Zero external dependencies (Node.js built-in `http` + `fs.watch`)
- Auto-compiles on `claims.json` changes (150ms debounce)
- Pushes updates to browser via SSE
- Timeline-first UI with phase-colored nodes and progressive disclosure

## Directory Structure

```
wheat/
├── .claude/
│   ├── commands/          # 17 slash command definitions
│   └── settings.local.json
├── claims.json            # The claim set (Bran IR)
├── compilation.json       # Compiler output (generated)
├── wheat-compiler.js      # 7-pass compilation pipeline
├── wheat-guard.js         # PreToolUse enforcement hook
├── wheat-init.js          # Bootstrap script (3 tiers)
├── wheat-server.js        # Live SSE dashboard server
├── wheat.config.json      # Configurable paths
├── build-pdf.js           # Markdown → PDF via md-to-pdf
├── package.json
├── CLAUDE.md              # Sprint context (auto-maintained)
├── research/              # Topic explainers (HTML + MD)
├── prototypes/            # Working proof-of-concepts
├── evidence/              # Evaluation results
├── output/                # Compiled artifacts (dashboards, briefs, slides)
└── templates/             # HTML/CSS templates for generation
```

## Git Discipline

- Every slash command that modifies `claims.json` auto-commits
- Commit format: `wheat: /<command> <summary> — added/updated <claim IDs>`
- `git log --oneline claims.json` = the sprint event log
- Compilation certificate references the claims hash for reproducibility

## Output Artifacts

All HTML artifacts are **fully self-contained** — inline CSS/JS, zero external dependencies. They work offline, can be emailed as attachments, or opened directly from the filesystem.

- **Explainers** — scroll-snap slide decks (dark theme) for research topics
- **Dashboards** — coverage, conflicts, phase progress at a glance
- **Briefs** — decision documents compiled from the claim set
- **Presentations** — stakeholder-ready slide decks
- **PDFs** — generated via `node build-pdf.js <file.md>`

## Requirements

- Node.js 18+
- Claude Code (for slash commands and guard hooks)
- `md-to-pdf` (optional, for PDF generation): `npm install`
