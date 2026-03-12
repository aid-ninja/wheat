#!/usr/bin/env node
/**
 * Remote Farmer — permission dashboard for Claude Code
 *
 * Receives HTTP hook events from Claude Code, pushes them to a browser
 * dashboard via Server-Sent Events (SSE), and relays approve/deny decisions.
 *
 * Zero npm dependencies — uses only Node built-in modules.
 *
 * Usage:
 *   node server.mjs [--port 9090] [--token mysecret] [--claims /path/to/claims.json]
 */

import { createServer } from 'node:http';
import { readFileSync, watchFile, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// --- Config ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const PORT = parseInt(arg('port', '9090'), 10);
const TOKEN = arg('token', randomBytes(16).toString('hex'));
const CLAIMS_PATH = resolve(arg('claims', './claims.json'));
const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- State ---
const pending = new Map();   // requestId → { resolve, data, timestamp }
const activity = [];         // last 200 activity events
const MAX_ACTIVITY = 200;
let claimsData = null;
let compilationData = null;

// --- Trust tiers ---
let trustLevel = 'paranoid'; // 'paranoid' | 'standard' | 'autonomous'
const sessionRules = [];     // [{tool: string, pattern?: string}]

const STANDARD_AUTO_APPROVE = new Set(['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']);

const DANGEROUS_BASH_PATTERNS = [
  /\brm\s+(-[^\s]*\s+)*\//,   // rm with absolute paths
  /\brm\s+-rf?\b/,            // rm -r or rm -rf
  /\bgit\s+push\b/,           // git push
  /\bgit\s+reset\s+--hard\b/, // git reset --hard
  /\bcurl\b.*\|\s*sh\b/,      // curl | sh
  /\bcurl\b.*\|\s*bash\b/,    // curl | bash
  /\bwget\b.*\|\s*sh\b/,      // wget | sh
  /\bsudo\b/,                 // sudo anything
  /\b(chmod|chown)\b/,        // permission changes
  /\bgit\s+push\s+.*--force\b/, // force push
];

function shouldAutoApprove(toolName, toolInput) {
  // Check session rules first (user-defined overrides)
  for (const rule of sessionRules) {
    if (rule.tool === toolName) {
      if (!rule.pattern) return true;
      // If pattern specified, check against file_path or command
      const target = toolInput?.file_path || toolInput?.command || toolInput?.pattern || '';
      if (target.includes(rule.pattern) || minimatch(target, rule.pattern)) return true;
    }
  }

  if (trustLevel === 'paranoid') return false;

  if (trustLevel === 'standard') {
    return STANDARD_AUTO_APPROVE.has(toolName);
  }

  if (trustLevel === 'autonomous') {
    // Auto-approve everything EXCEPT dangerous Bash patterns
    if (toolName === 'Bash' && toolInput?.command) {
      const cmd = toolInput.command;
      for (const pat of DANGEROUS_BASH_PATTERNS) {
        if (pat.test(cmd)) return false;
      }
    }
    return true;
  }

  return false;
}

// Simple glob-like match (just checks if pattern appears in string or does basic * matching)
function minimatch(str, pattern) {
  if (!pattern.includes('*')) return str === pattern;
  // Escape regex special chars, then convert * to .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp('^' + escaped + '$');
  return regex.test(str);
}

// --- SSE clients ---
const sseClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

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

// --- HTTP Server ---
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const authOk = () => {
    const provided = url.searchParams.get('token') || '';
    if (provided.length !== TOKEN.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
  };

  // --- SSE endpoint ---
  if (req.method === 'GET' && url.pathname === '/events') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',           // nginx/Cloudflare: disable proxy buffering
      'Content-Encoding': 'identity',       // prevent chunked compression that breaks SSE
    });
    res.flushHeaders();

    // Send current state as separate small SSE messages (mobile proxies choke on large single messages)
    const initBase = JSON.stringify({
      type: 'init',
      data: {
        pending: [...pending.entries()].map(([id, p]) => ({ id, ...p.data, timestamp: p.timestamp })),
        activity: activity.slice(-50),
        claims: null,
        compilation: null,
        trustLevel,
        sessionRules,
      }
    });
    res.write(`data: ${initBase}\n\n`);
    if (claimsData) res.write(`data: ${JSON.stringify({ type: 'claims', data: claimsData })}\n\n`);
    if (compilationData) res.write(`data: ${JSON.stringify({ type: 'compilation', data: compilationData })}\n\n`);

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // --- Hook endpoints (called by Claude Code — localhost only) ---
  if (req.method === 'POST' && url.pathname.startsWith('/hooks/')) {
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end('Hook endpoints accept localhost only'); return;
    }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request too large'); return; }
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const hookType = url.pathname.split('/hooks/')[1];

    if (hookType === 'permission') {
      return handlePermission(data, res);
    }
    if (hookType === 'activity') {
      return handleActivity(data, res);
    }
    if (hookType === 'notification') {
      return handleNotification(data, res);
    }
    res.writeHead(404); res.end('Unknown hook');
    return;
  }

  // --- Dashboard API ---
  if (req.method === 'POST' && url.pathname === '/api/decide') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request too large'); return; }
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
    return handleDecision(data, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/trust-level') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request too large'); return; }
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
    return handleTrustLevel(data, res);
  }

  if (req.method === 'POST' && url.pathname === '/api/rules') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(413); res.end('Request too large'); return; }
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }
    return handleRules(data, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pending: [...pending.entries()].map(([id, p]) => ({ id, ...p.data, timestamp: p.timestamp })),
      activity: activity.slice(-50),
      claims: claimsData,
      compilation: compilationData,
      trustLevel,
      sessionRules,
    }));
    return;
  }

  // --- Serve dashboard UI ---
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (!authOk()) {
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
function handlePermission(data, res) {
  const requestId = data.tool_use_id || randomBytes(8).toString('hex');
  const toolName = data.tool_name;
  const toolInput = data.tool_input;

  // Track agent starts from PreToolUse on Agent tool
  if (toolName === 'Agent') {
    broadcast({ type: 'agent_start', data: {
      id: requestId,
      description: toolInput?.description || '',
      agentType: toolInput?.subagent_type || 'general-purpose',
      timestamp: Date.now(),
    }});
  }

  // Check trust tiers FIRST — auto-approve if rules match
  if (shouldAutoApprove(toolName, toolInput)) {
    const hookEvent = data.hook_event_name || 'PermissionRequest';
    const reason = `Auto-approved by ${trustLevel} trust level`;
    let responseBody;

    if (hookEvent === 'PreToolUse') {
      responseBody = {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: reason,
        }
      };
    } else {
      responseBody = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', message: reason },
        }
      };
    }

    // Log to activity
    addActivity({
      type: 'decision',
      tool_name: toolName,
      tool_input: toolInput,
      decision: 'auto-allowed',
      reason,
      timestamp: Date.now(),
    });

    broadcast({ type: 'auto_approved', data: { requestId, tool_name: toolName, reason } });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
    return;
  }

  const event = {
    requestId,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: data.session_id,
    permission_mode: data.permission_mode,
    cwd: data.cwd,
    hook_event_name: data.hook_event_name,
    permission_suggestions: data.permission_suggestions,
  };

  broadcast({ type: 'permission_request', data: event });

  const timeout = setTimeout(() => {
    if (pending.has(requestId) && !resolved) {
      resolved = true;
      pending.delete(requestId);
      broadcast({ type: 'permission_expired', data: { requestId } });
      // CRITICAL: must explicitly deny on timeout — empty JSON = auto-allow (x001)
      const hookEvent = data.hook_event_name || 'PermissionRequest';
      const denyBody = hookEvent === 'PreToolUse'
        ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Remote approval timed out after 120s' } }
        : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Remote approval timed out after 120s' } } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(denyBody));
    }
  }, 120_000);

  let resolved = false; // guard against timeout/decide race (x005)
  pending.set(requestId, {
    resolve: (decision) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      pending.delete(requestId);

      const hookEvent = data.hook_event_name || 'PermissionRequest';
      let responseBody;

      if (hookEvent === 'PreToolUse') {
        responseBody = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.allow ? 'allow' : 'deny',
            permissionDecisionReason: decision.reason || (decision.allow ? 'Approved via Remote Farmer' : 'Denied via Remote Farmer'),
          }
        };
      } else {
        responseBody = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: decision.allow ? 'allow' : 'deny',
              message: decision.reason || (decision.allow ? 'Approved via Remote Farmer' : 'Denied via Remote Farmer'),
            }
          }
        };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));

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

// --- Trust level ---
function handleTrustLevel(data, res) {
  const valid = ['paranoid', 'standard', 'autonomous'];
  if (!valid.includes(data.level)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid level. Must be: paranoid, standard, autonomous' }));
    return;
  }
  trustLevel = data.level;
  broadcast({ type: 'trust_level', data: { level: trustLevel } });
  addActivity({
    type: 'decision',
    tool_name: 'system',
    tool_input: null,
    decision: 'trust-level-changed',
    reason: `Trust level set to ${trustLevel}`,
    timestamp: Date.now(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, level: trustLevel }));
}

// --- Session rules ---
function handleRules(data, res) {
  const { action, rule } = data;
  if (!rule || !rule.tool) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rule.tool is required' }));
    return;
  }

  if (action === 'add') {
    // Avoid duplicates
    const exists = sessionRules.find(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
    if (!exists) {
      sessionRules.push({ tool: rule.tool, pattern: rule.pattern || null });
    }
  } else if (action === 'remove') {
    const idx = sessionRules.findIndex(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
    if (idx !== -1) sessionRules.splice(idx, 1);
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'action must be add or remove' }));
    return;
  }

  broadcast({ type: 'rules_updated', data: { sessionRules } });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessionRules }));
}

// --- Notification handling (AskUserQuestion / elicitation / agents) ---
function handleNotification(data, res) {
  const hookEvent = data.hook_event_name || '';

  // Detect subagent lifecycle events from Agent tool notifications
  const toolName = data.tool_name || '';
  const message = data.message || data.body || data.tool_input?.prompt || '';

  if (toolName === 'Agent' || message.includes('subagent') || message.includes('Subagent')) {
    // Try to extract agent info from the notification
    const agentId = data.tool_use_id || randomBytes(8).toString('hex');
    const description = data.tool_input?.description || data.tool_input?.prompt || message;
    const agentType = data.tool_input?.subagent_type || 'general-purpose';

    if (message.toLowerCase().includes('start') || message.toLowerCase().includes('launch') || hookEvent.includes('Start')) {
      broadcast({ type: 'agent_start', data: { id: agentId, description, agentType, timestamp: Date.now() } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (message.toLowerCase().includes('stop') || message.toLowerCase().includes('complete') || hookEvent.includes('Stop')) {
      broadcast({ type: 'agent_stop', data: { id: agentId, timestamp: Date.now() } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
  }

  const isElicitation = hookEvent.includes('Notification') || hookEvent.includes('notification');

  // Check if this is an elicitation dialog
  const isElicitationDialog = data.tool_name === 'AskUserQuestion' ||
    (data.tool_input && data.tool_input.prompt) ||
    (data.elicitation_dialog);

  const event = {
    requestId: data.tool_use_id || randomBytes(8).toString('hex'),
    type: 'question',
    tool_name: data.tool_name || 'Notification',
    prompt: data.tool_input?.prompt || data.message || data.body || '',
    session_id: data.session_id,
    hook_event_name: hookEvent,
    timestamp: Date.now(),
  };

  if (isElicitationDialog || isElicitation) {
    // Push as a "question" type to browser
    broadcast({ type: 'question', data: event });

    // Hold the request for a user response (like permissions)
    const timeout = setTimeout(() => {
      if (pending.has(event.requestId) && !resolved) {
        resolved = true;
        pending.delete(event.requestId);
        broadcast({ type: 'question_expired', data: { requestId: event.requestId } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({}));
      }
    }, 120_000);

    let resolved = false;
    pending.set(event.requestId, {
      resolve: (decision) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        pending.delete(event.requestId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: hookEvent || 'Notification',
            userResponse: decision.response || '',
          }
        }));
        broadcast({ type: 'question_resolved', data: { requestId: event.requestId } });
      },
      data: { ...event, isQuestion: true },
      timestamp: Date.now(),
    });
  } else {
    // Simple notification — just broadcast and return
    broadcast({ type: 'notification', data: { title: 'Claude Code', body: event.prompt } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  }
}

// --- Activity feed ---
function handleActivity(data, res) {
  const isAgent = data.tool_name === 'Agent';

  // Track agent completion via PostToolUse/PostToolUseFailure
  if (isAgent) {
    const agentId = data.tool_use_id || randomBytes(8).toString('hex');
    broadcast({ type: 'agent_stop', data: { id: agentId, timestamp: Date.now() } });
  }

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
  const { requestId, allow, reason, response } = data;
  const p = pending.get(requestId);
  if (!p) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request not found or expired' }));
    return;
  }
  // If this is a question response, pass `response` field
  if (p.data.isQuestion) {
    p.resolve({ response: response || '' });
  } else {
    p.resolve({ allow, reason });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// --- Helpers ---
const MAX_BODY_SIZE = 1024 * 1024; // 1MB max request body

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
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
<title>Remote Farmer — Login</title>
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
  <h1>Remote Farmer</h1>
  <p>Enter the dashboard token from your terminal.</p>
  <form onsubmit="location.href='/?token='+document.getElementById('t').value;return false;">
    <input id="t" type="password" placeholder="Token" autofocus>
    <button type="submit">Connect</button>
  </form>
</div></body></html>`;
}

function dashboardPage(token) {
  const htmlPath = join(__dirname, 'dashboard.html');
  let html = readFileSync(htmlPath, 'utf8');
  return html.replace('{{TOKEN}}', token);
}

server.listen(PORT, () => {
  console.log(`\n  Remote Farmer`);
  console.log(`  ─────────────`);
  console.log(`  Local:  http://localhost:${PORT}/?token=${TOKEN}`);
  console.log(`  Token:  ${TOKEN}`);
  console.log(`  Claims: ${CLAIMS_PATH}`);
  console.log(`\n  Hook endpoints:`);
  console.log(`    http://localhost:${PORT}/hooks/permission`);
  console.log(`    http://localhost:${PORT}/hooks/activity`);
  console.log(`    http://localhost:${PORT}/hooks/notification`);
  console.log(`\n  SSE stream: /events?token=${TOKEN}`);
  console.log(`  Waiting for connections...\n`);
});
