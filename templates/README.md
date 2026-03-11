# templates/

HTML and CSS templates used by Wheat's build tools to generate self-contained output artifacts.

## Files

- **dashboard.html** — Status dashboard template. Used by `/status` to render claim counts, coverage maps, and conflict graphs.
- **explainer.html** — Dark scroll-snap template for topic explainers. Used by `/research` to produce deep-dive pages.
- **report.css** — Shared CSS for PDF-targeted Markdown reports. Imported by `build-pdf.js`.
- **replay.html** — Interactive sprint replay viewer template. Contains `__FRAMES_PLACEHOLDER__` marker that `build-replay.js` replaces with the serialized frames array.

## Conventions

- All templates use **CSS custom properties** defined in `:root` (e.g., `--bg-dark`, `--accent`, `--text`).
- Templates are **self-contained** — no external stylesheets, fonts, or scripts. System font stacks only.
- Dark theme throughout: `--bg-dark: #0f172a`, `--bg-card: #1e293b`.
- Placeholders use double-underscore convention: `__PLACEHOLDER_NAME__`.
