#!/usr/bin/env node
/**
 * Remote Permission Dashboard for Claude Code
 *
 * Receives HTTP hook events from Claude Code, pushes them to a browser
 * dashboard via WebSocket, and relays approve/deny decisions back.
 *
 * Zero npm dependencies — uses Node built-in http, fs, crypto, and WebSocket.
 *
 * Usage:
 *   node server.mjs [--port 9090] [--token mysecret] [--claims /path/to/claims.json]
 *
 * Then configure Claude Code hooks to POST to http://localhost:9090/hooks/*
 */

import { createServer } from 'node:http';
import { readFileSync, watchFile, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { WebSocketServer } from './ws.mjs';

// --- Config ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = parseInt(arg('port', '9090'), 10);
const TOKEN = arg('token', randomBytes(16).toString('hex'));
const CLAIMS_PATH = resolve(arg('claims', './claims.json'));

// --- State ---
const pending = new Map();   // requestId → { resolve, data, timestamp }
const activity = [];         // last 200 activity events
const MAX_ACTIVITY = 200;
let claimsData = null;
let compilationData = null;

// Load claims
function loadClaims() {
  try {
    if (existsSync(CLAIMS_PATH)) {
      claimsData = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8'));
      broadcast({ type: 'claims', data: claimsData });
    }
  } catch { /* ignore parse errors */ }
}

function loadCompilation() {
  const compPath = CLAIMS_PATH.replace('claims.json', 'compilation.json');
  try {
    if (existsSync(compPath)) {
      compilationData = JSON.parse(readFileSync(compPath, 'utf8'));
      broadcast({ type: 'compilation', data: compilationData });
    }
  } catch { /* ignore */ }
}

loadClaims();
loadCompilation();
watchFile(CLAIMS_PATH, { interval: 1000 }, loadClaims);

// --- WebSocket ---
const wss = new WebSocketServer();
const clients = new Set();

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// --- HTTP Server ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Auth check for non-hook routes (hooks use their own token via headers)
  const authOk = (r) => {
    const t = new URL(r.url, `http://localhost:${PORT}`).searchParams.get('token');
    return t === TOKEN;
  };

  // --- Hook endpoints (called by Claude Code) ---
  if (req.method === 'POST' && url.pathname.startsWith('/hooks/')) {
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const hookType = url.pathname.split('/hooks/')[1];

    if (hookType === 'permission') {
      return handlePermission(data, res);
    }
    if (hookType === 'activity') {
      return handleActivity(data, res);
    }
    res.writeHead(404); res.end('Unknown hook');
    return;
  }

  // --- Dashboard API ---
  if (req.method === 'POST' && url.pathname === '/api/decide') {
    if (!authOk(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const body = await readBody(req);
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
    return handleDecision(data, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!authOk(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pending: [...pending.entries()].map(([id, p]) => ({ id, ...p.data, timestamp: p.timestamp })),
      activity: activity.slice(-50),
      claims: claimsData,
      compilation: compilationData,
    }));
    return;
  }

  // --- Serve dashboard UI ---
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!authOk(req)) {
      // Show login page
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(loginPage());
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(dashboardPage(TOKEN));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// --- Permission handling ---
// Claude Code POSTs here and WAITS for our response (synchronous hook)
function handlePermission(data, res) {
  const requestId = data.tool_use_id || randomBytes(8).toString('hex');
  const event = {
    requestId,
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    session_id: data.session_id,
    permission_mode: data.permission_mode,
    cwd: data.cwd,
    hook_event_name: data.hook_event_name,
    permission_suggestions: data.permission_suggestions,
  };

  // Push notification to browser
  broadcast({ type: 'permission_request', data: event });

  // Play notification sound hint
  broadcast({ type: 'notification', data: { title: `${data.tool_name} needs approval`, body: summarizeInput(data.tool_input) } });

  // Hold the HTTP response open until the browser decides
  const timeout = setTimeout(() => {
    // Auto-fallthrough after 120s — let Claude Code's local prompt handle it
    if (pending.has(requestId)) {
      pending.delete(requestId);
      broadcast({ type: 'permission_expired', data: { requestId } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({})); // empty = no decision, falls through
    }
  }, 120_000);

  pending.set(requestId, {
    resolve: (decision) => {
      clearTimeout(timeout);
      pending.delete(requestId);

      const hookEvent = data.hook_event_name || 'PermissionRequest';
      let responseBody;

      if (hookEvent === 'PreToolUse') {
        responseBody = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.allow ? 'allow' : 'deny',
            permissionDecisionReason: decision.reason || (decision.allow ? 'Approved via remote dashboard' : 'Denied via remote dashboard'),
          }
        };
      } else {
        responseBody = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: decision.allow ? 'allow' : 'deny',
              message: decision.reason || (decision.allow ? 'Approved via remote dashboard' : 'Denied via remote dashboard'),
            }
          }
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));

      // Log to activity
      addActivity({
        type: 'decision',
        tool_name: data.tool_name,
        tool_input: data.tool_input,
        decision: decision.allow ? 'allowed' : 'denied',
        reason: decision.reason,
        timestamp: Date.now(),
      });

      broadcast({ type: 'permission_resolved', data: { requestId, decision: decision.allow ? 'allowed' : 'denied' } });
    },
    data: event,
    timestamp: Date.now(),
  });
}

// --- Activity feed ---
function handleActivity(data, res) {
  addActivity({
    type: data.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success',
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    tool_result: data.tool_result ? summarizeResult(data.tool_result) : null,
    session_id: data.session_id,
    timestamp: Date.now(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
}

function addActivity(event) {
  activity.push(event);
  if (activity.length > MAX_ACTIVITY) activity.shift();
  broadcast({ type: 'activity', data: event });
}

// --- Decision from browser ---
function handleDecision(data, res) {
  const { requestId, allow, reason } = data;
  const p = pending.get(requestId);
  if (!p) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request not found or expired' }));
    return;
  }
  p.resolve({ allow, reason });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// --- Helpers ---
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

function summarizeInput(input) {
  if (!input) return '';
  if (input.command) return input.command.slice(0, 200);
  if (input.file_path) return input.file_path;
  if (input.pattern) return `grep: ${input.pattern}`;
  return JSON.stringify(input).slice(0, 200);
}

function summarizeResult(result) {
  if (!result) return null;
  const s = typeof result === 'string' ? result : JSON.stringify(result);
  return s.slice(0, 500);
}

// --- HTML pages ---
function loginPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Remote — Login</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .login { background: #1e293b; padding: 40px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.06); max-width: 380px; width: 100%; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #94a3b8; font-size: 14px; margin-bottom: 20px; }
  input { width: 100%; padding: 10px 14px; border: 1px solid rgba(255,255,255,0.1); background: #0f172a; color: #f1f5f9; border-radius: 8px; font-size: 14px; margin-bottom: 12px; }
  button { width: 100%; padding: 10px; background: #3b82f6; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:hover { filter: brightness(1.1); }
</style></head><body>
<div class="login">
  <h1>Claude Code Remote</h1>
  <p>Enter the dashboard token from your terminal.</p>
  <form onsubmit="location.href='/?token='+document.getElementById('t').value;return false;">
    <input id="t" type="password" placeholder="Token" autofocus>
    <button type="submit">Connect</button>
  </form>
</div></body></html>`;
}

function dashboardPage(token) {
  const htmlPath = join(import.meta.dirname || new URL('.', import.meta.url).pathname, 'dashboard.html');
  let html = readFileSync(htmlPath, 'utf8');
  return html.replace('{{TOKEN}}', token);
}

// --- WebSocket upgrade ---
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    // Send initial state
    ws.send(JSON.stringify({
      type: 'init',
      data: {
        pending: [...pending.entries()].map(([id, p]) => ({ id, ...p.data, timestamp: p.timestamp })),
        activity: activity.slice(-50),
        claims: claimsData,
        compilation: compilationData,
      }
    }));
  });
});

server.listen(PORT, () => {
  console.log(`\n  Remote Permission Dashboard`);
  console.log(`  ──────────────────────────`);
  console.log(`  Local:  http://localhost:${PORT}/?token=${TOKEN}`);
  console.log(`  Token:  ${TOKEN}`);
  console.log(`  Claims: ${CLAIMS_PATH}`);
  console.log(`\n  Configure Claude Code hooks to POST to:`);
  console.log(`    http://localhost:${PORT}/hooks/permission`);
  console.log(`    http://localhost:${PORT}/hooks/activity`);
  console.log(`\n  Waiting for connections...\n`);
});
