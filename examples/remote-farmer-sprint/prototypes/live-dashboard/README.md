# Live Dashboard Prototype

A Server-Sent Events (SSE) prototype that streams compilation changes to a browser dashboard in real time.

## Running

```bash
node prototypes/live-dashboard/wheat-server.js
```

Then open `http://localhost:3001` (or the port shown in the console).

## What It Demonstrates

- **SSE streaming**: The server watches `compilation.json` for changes and pushes updates to connected browsers via Server-Sent Events.
- **Zero-dependency server**: Built on Node's built-in `http` module — no Express, no Socket.io.
- **Self-contained client**: `dashboard.html` is served inline with all CSS/JS embedded.

## Files

- `wheat-server.js` — Node HTTP server with SSE endpoint and file watcher
- `dashboard.html` — Client-side dashboard that connects to the SSE stream
