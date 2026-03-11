# Wheat Command Suite Expansion — Research

## Current State: 17 Commands, 3 Tiers

The Wheat command suite has expanded from 10 original commands to 17, organized into three functional tiers.

### Tier 1: Sprint Lifecycle (Original 10)
These form the core pipeline: define → research → build → evaluate → ship.

| Command | Role | Modifies claims? | Generates artifact? |
|---------|------|:-:|:-:|
| `/init` | Bootstrap sprint, seed constraints | Yes (d###) | problem-statement.html |
| `/research` | Deep dive, extract findings | Yes (r###) | explainer HTML + MD |
| `/prototype` | Build & test | Yes (p###) | demo.html |
| `/evaluate` | Test claims against reality | Yes (e###) | comparison dashboard |
| `/feedback` | Incorporate stakeholder input | Yes (f###) | — |
| `/resolve` | Manually adjudicate conflicts | Yes (updates status) | — |
| `/status` | Render current dashboard | No | dashboard.html |
| `/brief` | Compile decision document | No | brief HTML + MD |
| `/present` | Generate presentation | No | slides HTML |
| `/connect` | Link external data sources | No (updates meta) | — |

### Tier 2: Quality Assurance (New)
These stress-test the claim set's integrity, completeness, and accuracy.

| Command | Role | Claim prefix | Key innovation |
|---------|------|:----------:|----------------|
| `/challenge` | Devil's advocacy | x### | Adversarial research — finds counter-evidence |
| `/blind-spot` | Structural gap analysis | — (read-only) | Dependency gaps, type monoculture, echo chambers, evidence ceiling |
| `/witness` | External corroboration | w### | Targeted URL-based verification with relationship classification |
| `/calibrate` | Score predictions vs outcomes | cal### | Production-tier evidence; validates the framework itself |

### Tier 3: Operations (New)
These handle multi-sprint, multi-person, and historical workflows.

| Command | Role | Key innovation |
|---------|------|----------------|
| `/replay` | Time-travel through sprint | Recompiles every git version with current compiler, computes deltas |
| `/handoff` | Package for successor | Reconstructs reasoning chains per-topic for knowledge transfer |
| `/merge` | Combine sprints | Cross-sprint conflict detection, ID prefixing, topic alignment |

## Compiler Expansion (v0.1.0 → v0.2.0)

The compiler grew from ~430 to 685 lines with these additions:

1. **`--input`/`--output` flags** — compile arbitrary claims files (enables /replay and /merge)
2. **`--diff` mode** — compute deltas between two compilation.json files (enables /replay)
3. **Source diversity tracking** — `source_origins` and `source_count` per topic
4. **Type diversity tracking** — `type_diversity` and `missing_types` per topic
5. **Corroboration system** — tracks `witnessed_claim` support relationships
6. **Constraint-aware coverage** — `W_CONSTRAINT_ONLY` vs `W_WEAK_EVIDENCE`
7. **`loadConfig()`** — wheat.config.json for customizable paths
8. **Burn-residue safety** — rejects `burn-` prefixed synthetic claims
9. **Module exports** — `compile()`, `diffCompilations()` etc. for library use

## Claim ID Namespace

The expansion introduces new prefixes:
- `d###` — define (from /init)
- `r###` — research (from /research)
- `p###` — prototype (from /prototype)
- `e###` — evaluate (from /evaluate)
- `f###` — feedback (from /feedback)
- `x###` — challenge (from /challenge) **NEW**
- `w###` — witness (from /witness) **NEW**
- `cal###` — calibration (from /calibrate) **NEW**
- `burn-` — synthetic (from /control-burn, rejected by compiler) **NEW**

## Analysis: What the Expansion Enables

### Self-correction loop
`/challenge` → finds counter-evidence → creates conflict → `/resolve` → better claim survives. This is adversarial epistemics built into the workflow.

### External validation loop
`/witness` → corroborates with URL → compiler tracks corroboration count → higher confidence claims. This bridges the gap between internal reasoning and external evidence.

### Meta-learning loop
`/calibrate` → scores predictions against production outcomes → validates evidence tier hierarchy → informs future sprints. This is the only command that tests whether Wheat itself works.

### Multi-sprint operations
`/merge` → combines two independent research sprints → `/replay` → shows how the combined knowledge evolved → `/handoff` → packages for the next person.

## Gaps Still Present

1. **No `/control-burn` command** — burn-residue safety check exists in compiler but no command implements it
2. **No `/retract` command** — no formal way to withdraw a claim (only supersede via conflict)
3. **No `/search` command** — no way to full-text search claims from CLI
4. **No automated `/witness`** — witness requires manual URL; could auto-search for corroboration
