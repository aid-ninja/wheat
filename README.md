# Wheat

Research-driven development framework for Claude Code. Turns messy research into structured, evidence-graded claims that compile into decision-ready artifacts.

## What is Wheat?

Technical research is hard to track. Findings scatter across tabs, docs, and conversations. Decisions get made on gut feeling because nobody can reconstruct what was actually verified.

Wheat fixes this by giving you a structured sprint workflow inside Claude Code. Every finding becomes a **typed claim** with an **evidence tier**. A compiler validates the claim set, detects conflicts, and gates output artifacts on data integrity. The result: research you can trust, trace, and hand off.

It is built for developers and technical leads who need to make evidence-based decisions -- whether evaluating a library, choosing an architecture, or scoping a migration.

## Prerequisites

- Node.js >= 18
- [Claude Code](https://claude.ai/code) (Anthropic's CLI for Claude)
- Git (for sprint history tracking)

## Quick Start

```bash
git clone https://github.com/your-org/wheat.git
cd wheat
npm install
```

Then in Claude Code:

```
/init "Should we migrate from REST to GraphQL?"
/research "GraphQL performance characteristics"
/prototype
/evaluate
/brief
```

To install Wheat into an existing repo instead:

```bash
node wheat-init.js /path/to/your/repo        # Standard install
node wheat-init.js --full /path/to/your/repo  # Include templates and directories
```

## How It Works

The core loop is **define -> research -> prototype -> evaluate -> ship**.

1. `/init` sets the research question, audience, and constraints
2. Slash commands produce **claims** -- typed findings stored in `claims.json`
3. The **compiler** (`wheat-compiler.js`) validates claims, resolves conflicts by evidence tier, and outputs `compilation.json`
4. Output commands (`/brief`, `/present`) consume the compilation, never raw claims
5. Every claim modification auto-commits, so `git log --oneline claims.json` is your sprint event log

## Commands

### Tier 1: Sprint Lifecycle

| Command | Role |
|---------|------|
| `/init` | Bootstrap sprint -- set question, audience, constraints |
| `/research` | Deep dive on a topic -- HTML explainer + claims |
| `/prototype` | Build and test -- upgrades evidence to `tested` |
| `/evaluate` | Compare options against claims |
| `/feedback` | Incorporate stakeholder input |
| `/resolve` | Manually adjudicate conflicts between claims |
| `/status` | Render the sprint dashboard |
| `/brief` | Compile the decision document |
| `/present` | Generate a presentation from compiled claims |
| `/connect` | Link external data sources (GitHub, Jira, etc.) |

### Tier 2: Quality Assurance

| Command | Role |
|---------|------|
| `/challenge` | Devil's advocacy -- finds counter-evidence |
| `/blind-spot` | Structural gap analysis -- dependency gaps, type monoculture |
| `/witness` | External corroboration -- targeted URL-based verification |
| `/calibrate` | Score predictions vs outcomes |

### Tier 3: Operations

| Command | Role |
|---------|------|
| `/replay` | Time-travel through sprint evolution via git history |
| `/handoff` | Package sprint for knowledge transfer |
| `/merge` | Combine claim sets across independent sprints |

## CLI Tools

| Tool | Purpose |
|------|---------|
| `wheat-compiler.js` | 7-pass claim compiler (`--summary`, `--check`, `--gate`, `--diff`) |
| `wheat-init.js` | Sprint bootstrapper (standard, `--full`, `--headless` modes) |
| `wheat-guard.js` | Pre-commit guard -- blocks output writes unless compilation is fresh |
| `build-pdf.js` | Markdown to PDF generation (requires `md-to-pdf`) |
| `build-replay.js` | Replay viewer generator from git history |

## Example

See [`examples/self-referential-sprint/`](examples/self-referential-sprint/) for a complete 165-claim sprint that investigated its own visualization. Open `output/replay.html` in a browser for the interactive timeline replay.

## License

MIT
