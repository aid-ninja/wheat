# Replay UI — Interactive Sprint Timeline

## Research Question

How to build an interactive timeline/playback interface that visualizes a Wheat sprint evolving commit-by-commit — claims appearing, evidence upgrading, conflicts resolving, coverage growing — in a self-contained HTML file.

## Architecture: Pre-Computed Frames

The dominant pattern across Observable (Bostock's Bar Chart Race), COVID dashboards, and election trackers is **pre-computed frames with a stateless render function**:

1. **Frame array**: `frames[i]` = full sprint state at commit `i` (claims, coverage, stats, delta from previous)
2. **Stateless render**: `render(frame)` updates the entire DOM to match the frame
3. **Controller**: manages `currentFrame`, `playing`, `speed`; drives a `requestAnimationFrame` loop
4. **Scrubber**: `<input type="range" step="1">` bound bidirectionally to `currentFrame`

This separates data (baked at generation time) from presentation (runs in the browser).

### Data Pipeline

Reuses the existing `/replay` command infrastructure:

```
git log --oneline -- claims.json     → list of commits
git show <hash>:claims.json          → snapshot at each commit
node wheat-compiler.js --input X     → compile each snapshot
node wheat-compiler.js --diff A B    → delta between consecutive compilations
```

Output: a `const FRAMES = [...]` block embedded in the HTML.

Each frame contains:
- `commit`: hash, message, date
- `compilation`: full compiler output (claims, coverage, stats)
- `delta`: what changed from previous frame (new/removed/upgraded claims)
- `milestone`: auto-detected phase transitions, evidence jumps, conflict events

## Scrubber UX [r043]

Three components:

| Component | Implementation | Notes |
|---|---|---|
| Range slider | `<input type="range" min="0" max="N-1" step="1">` | Discrete frame snapping |
| Play/pause | Button toggling `requestAnimationFrame` loop | Auto-pauses on user scrub |
| Progress fill | JS-driven CSS gradient on track | No pure CSS cross-browser solution |

**Keyboard**: Left/Right arrows step ±1 frame. Space toggles play/pause. Home/End jump to first/last.

**Speed control**: 1x (1 frame/sec), 2x, 4x, or "instant" (jump with no animation).

## Animation Approach [r044]

### Claim Transitions

| Change | Technique | Details |
|---|---|---|
| Claim appears | CSS `opacity: 0→1` + `translateY(10px→0)` | 300ms ease-out, staggered by index |
| Claim removed | CSS `opacity: 1→0` + `scale(0.95)` | 200ms, then `display: none` |
| Evidence upgrade | Background color pulse (amber flash) | CSS transition on `background-color` |
| Status change | Badge color transition | Smooth via CSS `transition: all 0.3s` |
| Reorder | FLIP technique | Measure → DOM change → inverse transform → animate |

### Coverage Visualization

Horizontal stacked bars per topic. Each segment = evidence tier (color-coded). Bars grow/shrink via CSS `width` transitions. New topics slide in from left.

### Stats Counters

Animated number counters using `requestAnimationFrame` with exponential ease-out:
```js
current += (target - current) * 0.15;
```

## Diff Display [r045]

Per-frame delta rendered as:

1. **Summary bar**: "Frame 12: +3 claims, 1 upgraded, 2 topics covered" — always visible
2. **Inline badges**: Each claim gets a colored badge when it was added/changed in the current frame
3. **Delta panel** (collapsible): Full list of changes, color-coded

Color scheme:
- Green (`--green`): new claim added
- Amber (`--orange`): evidence or status upgraded
- Red (`--red`): claim superseded or removed
- Purple (`--purple`): conflict detected or resolved

## Layout

```
┌─────────────────────────────────────────────────┐
│  Sprint Replay: "Wheat live visualization"      │
│  ▶ ──●────────────────── Frame 12/30  2x        │
│  wheat: /prototype "live-dashboard" — p001-p005  │
├──────────────────────┬──────────────────────────┤
│  Claims (grouped)    │  Coverage Map            │
│  ┌─ dogfooding ─────┐│  ████░░ dogfooding      │
│  │ + p001 [tested]  ││  ██████ output-format    │
│  │ + p002 [tested]  ││  ██░░░░ audience         │
│  │   d001 [stated]  ││  ...                     │
│  └──────────────────┘│                          │
│  ┌─ architecture ───┐│  Stats                   │
│  │   r001 [web]     ││  Claims: 15 (+5)         │
│  │   r002 [web]     ││  Topics: 4 (+1)          │
│  └──────────────────┘│  Conflicts: 0            │
├──────────────────────┴──────────────────────────┤
│  Delta: +5 claims (3 factual, 2 recommendation) │
│  New topic: dogfooding                           │
│  Milestone: entered prototype phase              │
└─────────────────────────────────────────────────┘
```

## Risk: Git Dependency [r047]

Frame extraction requires `git show <hash>:claims.json` — this only works in a git repo with intact history. Mitigations:
- The generated HTML is self-contained and survives repo deletion
- Archived sprints on orphan branches/tags preserve history
- Force-push or rebase can destroy historical frames — use `--no-force` convention

## Prior Art

| Tool | Pattern | Relevance |
|---|---|---|
| Bostock Bar Chart Race | Pre-computed frames + range scrubber | Direct analog — ranked items evolving over time |
| pomber/git-history | Git snapshots → animated transitions | File-level replay, similar data extraction |
| Gource | Commit log → real-time animation | Too complex (3D tree), but same data source |
| COVID time-series dashboards | Date slider + synchronized views | Multi-panel layout with shared frame index |
| GitHub Next repo viz | D3 packing + animated transitions | Treemap morphing between states |

## Claims

- [r042] Pre-computed frame architecture
- [r043] Scrubber UX pattern (range + play/pause + progress fill)
- [r044] Animation techniques (CSS transitions, FLIP, View Transitions API)
- [r045] Claim diff display (set operations, not generic JSON diff)
- [r046] Data pipeline reuses existing compiler --input/--diff
- [r047] Risk: git dependency for frame extraction
