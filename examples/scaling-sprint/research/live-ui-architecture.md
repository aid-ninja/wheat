# Live UI Architecture for Wheat

## Research Question
How can we build a real-time web UI that shows the Wheat compiler working live, updating as claims change — so users don't have to stay in the terminal?

## Key Findings

### Architecture: Zero-Dep Node.js Server + SSE
- **Server-Sent Events (SSE)** is the right transport: one-way (server→browser), auto-reconnect built in, zero dependencies [r001]
- **fs.watch** is sufficient for watching claims.json — uses OS-level notifications, no need for chokidar [r002]
- Browser-only approaches (File System Access API) are dead ends: Chrome-only, need manual file picker, still need a server for CLI commands [r003]
- The whole server is ~80-100 lines with zero npm dependencies [r008]

### UX Patterns
- **AST Explorer pattern**: input left, compiled output right, live updates [r004]
- **GitHub Actions stepper**: linear pipeline visualization for compiler passes with color-coded status [r005]
- **Next.js HMR trick**: send just a hash over SSE, let client fetch full data via HTTP [r006]

### The Server vs Static Tension
- A live UI needs a running server, but Wheat's convention is self-contained HTML [r007]
- Resolution: **two artifacts** — `wheat-server.js` is the dev tool (runs locally), the HTML it serves is still portable
- The server watches claims.json, auto-runs the compiler, and pushes updates via SSE
- The HTML reads from compilation.json (through the server), never claims.json directly — maintaining pipeline integrity

### Data Flow
```
claims.json
    ↓ (fs.watch detects change)
wheat-compiler.js (auto-run by server)
    ↓ (writes)
compilation.json
    ↓ (SSE notification: "new hash")
Browser fetches /compilation.json
    ↓ (client-side rendering)
Live dashboard updates
```

## Conflicts
- r001 conflicts with d002: SSE server approach requires a running process, not a static HTML file
- r007 resolves this: the server is the dev experience, the HTML artifact remains portable

## Claim IDs
r001, r002, r003, r004, r005, r006, r007, r008
