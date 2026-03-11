# Contributing to Wheat

## Reporting Bugs

Open an issue using the **Bug Report** template. Include Node version, OS, and steps to reproduce.

## Submitting Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run `npm test` — all 8 tests must pass
4. Run `node wheat-compiler.js --scan` — all HTML must be self-contained
5. Open a PR against `main`

## Running Tests

```bash
npm test              # runs node --test test/
npm run compile       # runs the compiler
node build-replay.js  # regenerates the replay viewer
```

After regenerating output artifacts, sync to the docs folder:

```bash
npm run sync-docs
```

## Code Conventions

- **Zero runtime dependencies** for core tools (`wheat-compiler.js`, `build-replay.js`, `build-pdf.js`). Everything runs on Node built-ins.
- **Self-contained HTML outputs** — inline all CSS and JS, no CDN links, no external fonts. Use system font stacks.
- **Dark theme** — all HTML artifacts use the dark scroll-snap template with CSS custom properties.
- **Deterministic output** — same input claims should produce identical compilation. Sort by evidence tier, then lexicographic by ID.

## Slash Command Development

Wheat slash commands live in `.claude/commands/*.md`. Each file is a prompt template that Claude Code executes. To add a new command:

1. Create `.claude/commands/your-command.md`
2. Define the prompt with `$ARGUMENTS` placeholder for user input
3. Follow the claims system: append to `claims.json`, run the compiler, suggest next steps
4. Update the intent router table in `CLAUDE.md`

## Project Structure

```
wheat-compiler.js    — Core compiler (validation, conflict detection, resolution)
build-replay.js      — Git history → interactive replay viewer
build-pdf.js         — Markdown → PDF via md-to-pdf (optional dep)
claims.json          — Source of truth for all research claims
compilation.json     — Compiler output consumed by all artifacts
templates/           — HTML/CSS templates for artifact generation
output/              — Generated artifacts (brief, presentation, replay, dashboard)
prototypes/          — Working proof-of-concepts
research/            — Topic explainers
evidence/            — Evaluation results
docs/                — GitHub Pages site
```
