#!/usr/bin/env node
/**
 * Wheat Live Server — zero-dependency real-time dashboard
 *
 * Watches claims.json, auto-compiles, pushes updates via SSE.
 * Usage: node prototypes/live-dashboard/wheat-server.js [port]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PORT = parseInt(process.argv[2] || '3141', 10);
const ROOT = path.resolve(__dirname, '..', '..');
const CLAIMS = path.join(ROOT, 'claims.json');
const COMPILATION = path.join(ROOT, 'compilation.json');
const COMPILER = path.join(ROOT, 'wheat-compiler.js');
const DASHBOARD = path.join(__dirname, 'dashboard.html');

// ── SSE clients ─────────────────────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(msg);
  }
}

// ── Compiler ────────────────────────────────────────────────────────────────
function compile() {
  try {
    execSync(`node "${COMPILER}"`, { cwd: ROOT, stdio: 'pipe' });
    const compilation = JSON.parse(fs.readFileSync(COMPILATION, 'utf8'));
    return { ok: true, compilation };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── File watcher ────────────────────────────────────────────────────────────
// Watch the directory, not the file — fs.watch loses the watcher on macOS
// when the file is atomically replaced (new inode), which writeFileSync and
// git operations both do.
let debounce = null;

fs.watch(path.dirname(CLAIMS), (eventType, filename) => {
  if (filename !== path.basename(CLAIMS)) return;
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    console.log('[wheat] claims.json changed — recompiling...');
    const result = compile();
    if (result.ok) {
      console.log(`[wheat] compiled: ${result.compilation.sprint_meta.active_claims} claims, status ${result.compilation.status}`);
      broadcast('compilation', {
        hash: result.compilation.claims_hash,
        status: result.compilation.status,
        timestamp: result.compilation.compiled_at,
      });
    } else {
      console.error('[wheat] compile error:', result.error);
      broadcast('error', { message: result.error });
    }
  }, 150);
});

// ── MIME types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // SSE endpoint
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Serve compilation.json
  if (url.pathname === '/compilation.json') {
    try {
      const data = fs.readFileSync(COMPILATION, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('compilation.json not found — run the compiler first');
    }
    return;
  }

  // Serve claims.json
  if (url.pathname === '/claims.json') {
    try {
      const data = fs.readFileSync(CLAIMS, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('claims.json not found');
    }
    return;
  }

  // Serve git log
  if (url.pathname === '/git-log') {
    try {
      const log = execSync('git log --oneline -20 claims.json 2>/dev/null || echo "no commits"', { cwd: ROOT }).toString();
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-cache' });
      res.end(log);
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('no commits');
    }
    return;
  }

  // Dashboard (root)
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(DASHBOARD, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end('dashboard.html not found');
    }
    return;
  }

  // Static files from project root (for research/output artifacts)
  const filePath = path.join(ROOT, url.pathname);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fs.readFileSync(filePath));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

// ── Start ───────────────────────────────────────────────────────────────────
// Initial compile
console.log('[wheat] initial compilation...');
const initial = compile();
if (initial.ok) {
  console.log(`[wheat] ready: ${initial.compilation.sprint_meta.active_claims} claims`);
}

server.listen(PORT, () => {
  console.log(`\n  🌾 Wheat Live Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
  console.log(`  Watching claims.json for changes...`);
  console.log(`  Every edit auto-compiles and pushes to your browser.\n`);
});
