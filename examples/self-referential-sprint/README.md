# Example: Self-Referential Sprint

A complete Wheat sprint that investigated its own visualization —
"How can we build a live visualization of Wheat that teaches the framework
by showing itself in action?"

## What's here

- **claims.json** — 165 claims across 9 topics
- **output/replay.html** — Interactive timeline replay (open in browser)
- **output/brief.html** — Decision document
- **output/presentation.html** — Stakeholder slides
- **output/handoff.md** — Knowledge transfer document
- **research/** — Topic explainers (HTML + Markdown)

## How to explore

Open any `.html` file directly in a browser — they're all self-contained.

To recompile:

```bash
node ../../wheat-compiler.js --input claims.json --output compilation.json --summary
```
