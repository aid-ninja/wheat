# Accessibility Audit — Wheat Dashboard & Artifacts

## Summary

The Wheat dashboard and HTML artifacts have **zero accessibility infrastructure**. No ARIA landmarks, no keyboard navigation, no screen reader support, and one critical contrast failure. The good news: the issues are well-scoped and fixable with 5 targeted changes.

## Contrast Audit

Tested all color pairs from the dashboard's CSS custom properties against WCAG 2.2 AA requirements (4.5:1 for normal text, 3:1 for UI components).

| Color Pair | Ratio | Text (4.5:1) | UI (3:1) |
|------------|------:|:---:|:---:|
| --text (#e8ecf4) on --bg (#0a0e1a) | 16.26:1 | PASS | PASS |
| --text-mid (#8b95a8) on --bg | 6.38:1 | PASS | PASS |
| **--text-dim (#505a6e) on --bg** | **2.78:1** | **FAIL** | **FAIL** |
| **--text-dim on --surface (#131825)** | **2.56:1** | **FAIL** | **FAIL** |
| --accent (#f0a030) on --bg | 8.96:1 | PASS | PASS |
| --blue (#4d8ef7) on --bg | 5.99:1 | PASS | PASS |
| --green (#34c759) on --bg | 8.67:1 | PASS | PASS |
| --red (#ff453a) on --bg | 5.65:1 | PASS | PASS |
| --purple (#b07df0) on --bg | 6.45:1 | PASS | PASS |
| --cyan (#32d1e0) on --bg | 10.39:1 | PASS | PASS |

**Finding**: Only `--text-dim` fails. Fix: raise to `#7a839a` (~4.5:1) or `#8690a3` (~5.2:1).

Where --text-dim is used: metadata labels, tags, phase subtitles, "Now" timestamp, compiler pass labels, scoreboard labels. All informational content. [r017]

## Semantic Structure

### Current State: Zero Landmarks

The entire dashboard is built with `<div>` elements. No `<header>`, `<main>`, `<nav>`, no `role` attributes. Screen readers present it as a flat soup of text.

### What's needed (WCAG SC 1.3.1):

- `<header role="banner">` for the topbar
- `<main>` wrapping the layout content
- `role="status"` on the scoreboard (it reflects live system state)
- `role="region" aria-label="Sprint Timeline"` on the timeline
- `aria-label` on the coverage strip

[r018]

## Keyboard Navigation

### Current State: Mouse-Only Interaction

Claim rows use `onclick="toggleDetail('r001')"` on a `<div>`. No keyboard affordance:
- No `tabindex="0"` → can't reach via Tab
- No `role="button"` → screen reader doesn't announce as interactive
- No `aria-expanded` → state not communicated
- No keydown handler → Enter/Space don't work

### Fix:

```html
<div class="tl-claim-row"
     tabindex="0"
     role="button"
     aria-expanded="false"
     onclick="toggleDetail('r001')"
     onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleDetail('r001')}">
```

Plus update `toggleDetail()` to set `aria-expanded` on the row.

[r019]

## Dynamic Content (SSE Updates)

### Current State: Silent Updates

When SSE pushes a compilation update, the DOM changes silently. Sighted users see animations. Screen reader users hear nothing.

### Fix:

- `aria-live="polite"` on the scoreboard → announces new claim counts
- `aria-live="polite"` on the timeline body → announces new claims
- Status pill change (ready/blocked) should use `role="status"` which is implicitly live

[r020]

## Recommended Fixes (Priority Order)

1. **Contrast**: Raise `--text-dim` to `#7a839a` — 1 line change, biggest impact
2. **Semantic landmarks**: Wrap in `<header>`, `<main>` — 3 tag changes
3. **Keyboard support**: Add tabindex, role, keydown to claim rows — JS update
4. **aria-live**: Add to scoreboard + timeline — 2 attribute additions
5. **Focus styles**: Add `:focus-visible` outlines — CSS block

All 5 fixes together are ~30 lines of changes. No visual impact on the existing design.

[r021]

## Template Issue

The explainer template (`templates/explainer.html`) has:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
```

This is:
- An external dependency (conflicts with d002 self-contained constraint)
- An accessibility risk (font load failure → layout shift, metric mismatch)
- A privacy concern (Google tracks font requests)

The dashboard already uses the system font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif`) as a fallback. The template should do the same and drop the import.

[r022]

## References

- WCAG 2.2 Specification: https://www.w3.org/TR/WCAG22/
- WebAIM Contrast Checker: https://webaim.org/resources/contrastchecker/
- ARIA Authoring Practices Guide: https://www.w3.org/WAI/ARIA/apg/
- MDN ARIA Documentation: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA
