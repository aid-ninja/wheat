#!/usr/bin/env node
/**
 * Remote Farmer — permission dashboard for Claude Code
 *
 * Receives HTTP hook events from Claude Code, pushes them to a browser
 * dashboard via Server-Sent Events (SSE), and relays approve/deny decisions.
 *
 * Multi-session support: each Claude Code session gets its own SessionState
 * (pending permissions, activity, trust level, rules). Sessions are lazily
 * initialized from hook payloads via getSession(session_id). If no session_id
 * is present in a hook payload, the "default" session is used (backwards compat).
 *
 * Zero npm dependencies — uses only Node built-in modules.
 *
 * Usage:
 *   node server.mjs [--port 9090] [--token mysecret] [--claims /path/to/claims.json]
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, watchFile, unwatchFile, existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
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

// --- SessionState class ---
class SessionState {
  constructor(sessionId, cwd) {
    this.id = sessionId;
    this.label = cwd ? cwd.split('/').pop() : sessionId.slice(0, 8);
    this.cwd = cwd || '';
    this.color = SessionState.hueFromId(sessionId);
    this.status = 'active';           // 'active' | 'stale' | 'ended'
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.source = null;               // 'startup' | 'resume' | 'clear' | 'compact'

    // Per-session state (previously global singletons)
    this.pending = new Map();         // requestId -> { resolve, data, timestamp }
    this.activity = [];               // last 200 events for this session
    this.messages = [];               // last 50 Claude messages for this session
    this.trustLevel = 'paranoid';     // 'paranoid' | 'standard' | 'autonomous'
    this.sessionRules = [];           // [{tool, pattern?}]
    this.agents = [];                 // agent tracking
  }

  static hueFromId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 360;
  }

  touch() {
    this.lastActivity = Date.now();
  }

  isStale(timeoutMs = 5 * 60 * 1000) {
    return this.status === 'active' && (Date.now() - this.lastActivity) > timeoutMs;
  }
}

// --- Session management ---
const sessions = new Map();  // session_id -> SessionState

function getSession(sessionId, cwd) {
  const id = sessionId || 'default';
  if (!sessions.has(id)) {
    const session = new SessionState(id, cwd);
    sessions.set(id, session);
    broadcast({ type: 'session_new', session_id: id, data: sessionSummary(session) });
  }
  const s = sessions.get(id);
  if (cwd && (!s.cwd || s.cwd !== cwd)) { s.cwd = cwd; s.label = cwd.split('/').pop(); }
  s.touch();
  return s;
}

function sessionSummary(s) {
  return {
    id: s.id,
    label: s.label,
    color: s.color,
    status: s.status,
    cwd: s.cwd,
    pending_count: s.pending.size,
    trust: s.trustLevel,
    startedAt: s.startedAt,
    lastActivity: s.lastActivity,
  };
}

// --- Global state (shared across sessions) ---
const MAX_ACTIVITY = 200;
let claimsData = null;
let compilationData = null;

// --- Agent tracking helpers (per-session) ---
function trackAgentStart(session, data) {
  session.agents.push({ id: data.id, description: data.description, agent_type: data.agentType, status: 'running', startedAt: data.timestamp });
  broadcast({ type: 'agent_start', session_id: session.id, data });
}
function trackAgentStop(session, data) {
  const a = session.agents.find(x => x.id === data.id);
  if (a) { a.status = 'done'; a.stoppedAt = data.timestamp; }
  broadcast({ type: 'agent_stop', session_id: session.id, data });
}

// Helper: find pending entry across all sessions
function findPending(requestId) {
  for (const [sid, session] of sessions) {
    if (session.pending.has(requestId)) {
      return { session, entry: session.pending.get(requestId) };
    }
  }
  return null;
}

// Helper: aggregate all pending across sessions
function allPending() {
  const result = [];
  for (const [sid, session] of sessions) {
    for (const [id, p] of session.pending) {
      result.push({ id, ...p.data, timestamp: p.timestamp, session_id: session.id, session_label: session.label, session_color: session.color });
    }
  }
  return result;
}

// Helper: aggregate all activity across sessions (latest 50)
function allActivity() {
  const result = [];
  for (const [sid, session] of sessions) {
    for (const a of session.activity) {
      result.push({ ...a, session_id: a.session_id || session.id });
    }
  }
  result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return result.slice(-50);
}

// Helper: aggregate all messages across sessions
function allMessages() {
  const result = [];
  for (const [sid, session] of sessions) {
    for (const m of session.messages) {
      result.push({ ...m, session_id: session.id });
    }
  }
  result.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return result;
}

// Helper: aggregate all agents across sessions
function allAgents() {
  const result = [];
  for (const [sid, session] of sessions) {
    for (const a of session.agents) {
      result.push({ ...a, session_id: session.id });
    }
  }
  return result;
}

// Helper: all sessions summary list
function allSessionsSummary() {
  return [...sessions.values()].map(sessionSummary);
}

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

function shouldAutoApprove(session, toolName, toolInput) {
  // Requests/questions always need human input — never auto-approve
  if (toolName === 'Request' || toolName === 'AskUserQuestion') return false;

  // Check session rules first (user-defined overrides)
  for (const rule of session.sessionRules) {
    if (rule.tool === toolName) {
      if (!rule.pattern) return true;
      // If pattern specified, check against file_path or command
      const target = toolInput?.file_path || toolInput?.command || toolInput?.pattern || '';
      if (target.includes(rule.pattern) || minimatch(target, rule.pattern)) return true;
    }
  }

  if (session.trustLevel === 'paranoid') return false;

  if (session.trustLevel === 'standard') {
    return STANDARD_AUTO_APPROVE.has(toolName);
  }

  if (session.trustLevel === 'autonomous') {
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

// --- Staleness detection ---
setInterval(() => {
  for (const [id, session] of sessions) {
    if (session.isStale()) {
      session.status = 'stale';
      broadcast({ type: 'session_stale', session_id: id, data: sessionSummary(session) });
    }
  }
}, 60_000);

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
    const defaultSession = sessions.has('default') ? sessions.get('default') : null;
    const initBase = JSON.stringify({
      type: 'init',
      data: {
        pending: allPending(),
        activity: allActivity(),
        claims: null,
        compilation: null,
        trustLevel: defaultSession ? defaultSession.trustLevel : 'paranoid',
        sessionRules: defaultSession ? defaultSession.sessionRules : [],
        agents: allAgents(),
        sessions: allSessionsSummary(),
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
    if (hookType === 'lifecycle') {
      return handleLifecycle(data, res);
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

  // Message from Claude (text output relay)
  if (req.method === 'POST' && url.pathname === '/api/message') {
    // No auth — called from localhost by Claude Code via curl
    const remoteAddr = req.socket.remoteAddress;
    if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
      res.writeHead(403); res.end('Localhost only'); return;
    }
    let body;
    try { body = await readBody(req); } catch { res.writeHead(413); res.end('Too large'); return; }
    let data;
    try { data = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const session = getSession(data.session_id, data.cwd);
    const msg = {
      type: 'message',
      content: data.content || data.message || '',
      timestamp: Date.now(),
      session_id: session.id,
    };
    session.messages.push(msg);
    if (session.messages.length > 50) session.messages.shift();
    broadcast({ type: 'message', session_id: session.id, data: msg });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    const defaultSession = sessions.has('default') ? sessions.get('default') : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pending: allPending(),
      activity: allActivity(),
      messages: allMessages(),
      claims: claimsData,
      compilation: compilationData,
      trustLevel: defaultSession ? defaultSession.trustLevel : 'paranoid',
      sessionRules: defaultSession ? defaultSession.sessionRules : [],
      agents: allAgents(),
      sessions: allSessionsSummary(),
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
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache' });
    res.end(dashboardPage(TOKEN));
    return;
  }

  // --- Serve output artifacts ---
  if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
    if (!authOk()) { res.writeHead(401); res.end('Unauthorized'); return; }
    const fileName = url.pathname.replace('/output/', '');
    // Sanitize: only allow simple filenames, no path traversal
    if (fileName.includes('..') || fileName.includes('/') || !fileName.match(/^[\w.-]+$/)) {
      res.writeHead(400); res.end('Invalid filename'); return;
    }
    const outputDir = resolve(CLAIMS_PATH, '..', 'output');
    const filePath = join(outputDir, fileName);
    try {
      const content = readFileSync(filePath, 'utf8');
      const ext = fileName.split('.').pop();
      const mime = { html: 'text/html', md: 'text/plain', json: 'application/json', pdf: 'application/pdf' }[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// --- Permission handling ---
function handlePermission(data, res) {
  const session = getSession(data.session_id, data.cwd);
  const requestId = data.tool_use_id || randomBytes(8).toString('hex');
  const toolName = data.tool_name;
  const toolInput = data.tool_input;

  // Track agent starts from PreToolUse on Agent tool
  if (toolName === 'Agent') {
    trackAgentStart(session, {
      id: requestId,
      description: toolInput?.description || '',
      agentType: toolInput?.subagent_type || 'general-purpose',
      timestamp: Date.now(),
    });
  }

  // Check trust tiers FIRST — auto-approve if rules match
  if (shouldAutoApprove(session, toolName, toolInput)) {
    const hookEvent = data.hook_event_name || 'PermissionRequest';
    const reason = `Auto-approved by ${session.trustLevel} trust level`;
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
    addActivity(session, {
      type: 'decision',
      tool_name: toolName,
      tool_input: toolInput,
      decision: 'auto-allowed',
      reason,
      session_id: session.id,
      timestamp: Date.now(),
    });

    broadcast({ type: 'auto_approved', session_id: session.id, data: { requestId, tool_name: toolName, reason } });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(responseBody));
    return;
  }

  const event = {
    requestId,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: session.id,
    session_label: session.label,
    session_color: session.color,
    permission_mode: data.permission_mode,
    cwd: data.cwd,
    hook_event_name: data.hook_event_name,
    permission_suggestions: data.permission_suggestions,
  };

  broadcast({ type: 'permission_request', session_id: session.id, data: event });

  const timeout = setTimeout(() => {
    if (session.pending.has(requestId) && !resolved) {
      resolved = true;
      session.pending.delete(requestId);
      broadcast({ type: 'permission_expired', session_id: session.id, data: { requestId } });
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
  session.pending.set(requestId, {
    resolve: (decision) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      session.pending.delete(requestId);

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

      addActivity(session, {
        type: 'decision',
        tool_name: data.tool_name,
        tool_input: data.tool_input,
        decision: decision.allow ? 'allowed' : 'denied',
        reason: decision.reason,
        session_id: session.id,
        timestamp: Date.now(),
      });

      broadcast({ type: 'permission_resolved', session_id: session.id, data: { requestId, decision: decision.allow ? 'allowed' : 'denied' } });
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

  // Apply to specific session or all sessions
  const targetSessionId = data.session_id;
  if (targetSessionId && sessions.has(targetSessionId)) {
    const session = sessions.get(targetSessionId);
    session.trustLevel = data.level;
    broadcast({ type: 'trust_level', session_id: session.id, data: { level: session.trustLevel } });
    addActivity(session, {
      type: 'decision',
      tool_name: 'system',
      tool_input: null,
      decision: 'trust-level-changed',
      reason: `Trust level set to ${session.trustLevel}`,
      session_id: session.id,
      timestamp: Date.now(),
    });
  } else {
    // Apply to all sessions (backwards compat: no session_id means global)
    for (const [sid, session] of sessions) {
      session.trustLevel = data.level;
    }
    broadcast({ type: 'trust_level', data: { level: data.level } });
    // Log to default session
    const defaultSession = getSession('default');
    addActivity(defaultSession, {
      type: 'decision',
      tool_name: 'system',
      tool_input: null,
      decision: 'trust-level-changed',
      reason: `Trust level set to ${data.level} (all sessions)`,
      session_id: 'default',
      timestamp: Date.now(),
    });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, level: data.level }));
}

// --- Session rules ---
function handleRules(data, res) {
  const { action, rule } = data;
  if (!rule || !rule.tool) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'rule.tool is required' }));
    return;
  }

  // Apply to specific session or all sessions
  const targetSessionId = data.session_id;
  const targetSessions = (targetSessionId && sessions.has(targetSessionId))
    ? [sessions.get(targetSessionId)]
    : [...sessions.values()];

  // If no sessions exist yet, create default
  if (targetSessions.length === 0) {
    targetSessions.push(getSession('default'));
  }

  for (const session of targetSessions) {
    if (action === 'add') {
      const exists = session.sessionRules.find(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
      if (!exists) {
        session.sessionRules.push({ tool: rule.tool, pattern: rule.pattern || null });
      }
    } else if (action === 'remove') {
      const idx = session.sessionRules.findIndex(r => r.tool === rule.tool && (r.pattern || '') === (rule.pattern || ''));
      if (idx !== -1) session.sessionRules.splice(idx, 1);
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'action must be add or remove' }));
      return;
    }
  }

  // Return the first target's rules for backwards compat
  const sessionRules = targetSessions[0].sessionRules;
  broadcast({ type: 'rules_updated', data: { sessionRules } });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, sessionRules }));
}

// --- Lifecycle handling (SessionStart / SessionEnd) ---
function handleLifecycle(data, res) {
  const { event, session_id, cwd, source, reason } = data;

  if (event === 'session_start') {
    const session = getSession(session_id, cwd);
    session.source = source;  // 'startup', 'resume', 'clear', 'compact'
    session.status = 'active';
    broadcast({ type: 'session_start', session_id, data: sessionSummary(session) });
  }

  if (event === 'session_end') {
    const session = sessions.get(session_id);
    if (session) {
      session.status = 'ended';
      session.endedAt = Date.now();
      session.endReason = reason;
      // Auto-deny any pending permissions for this session
      for (const [reqId, entry] of session.pending) {
        entry.resolve({ allow: false, reason: 'session ended' });
      }
      broadcast({ type: 'session_end', session_id, data: { reason } });
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
}

// --- Notification handling (AskUserQuestion / elicitation / agents) ---
function handleNotification(data, res) {
  const session = getSession(data.session_id, data.cwd);
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
      trackAgentStart(session, { id: agentId, description, agentType, timestamp: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (message.toLowerCase().includes('stop') || message.toLowerCase().includes('complete') || hookEvent.includes('Stop')) {
      trackAgentStop(session, { id: agentId, timestamp: Date.now() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
  }

  // Log notification payload for debugging
  console.log('[notification]', JSON.stringify(data).slice(0, 500));

  const isElicitation = hookEvent.includes('Notification') || hookEvent.includes('notification');

  // Check if this is an elicitation dialog
  const isElicitationDialog = data.tool_name === 'AskUserQuestion' ||
    (data.tool_input && data.tool_input.prompt) ||
    (data.elicitation_dialog);

  // Extract prompt from various possible locations in the hook payload
  const prompt = data.tool_input?.prompt
    || data.tool_input?.question
    || data.tool_input?.message
    || data.message
    || data.body
    || data.notification?.message
    || data.notification?.body
    || (typeof data.tool_input === 'string' ? data.tool_input : '')
    || '';

  const event = {
    requestId: data.tool_use_id || randomBytes(8).toString('hex'),
    type: 'question',
    tool_name: data.tool_name || 'Notification',
    prompt,
    session_id: session.id,
    session_label: session.label,
    session_color: session.color,
    hook_event_name: hookEvent,
    timestamp: Date.now(),
  };

  // Notifications are non-blocking in Claude Code — we can't hold the response.
  // Broadcast as activity/info and return immediately.
  broadcast({ type: 'notification_card', session_id: session.id, data: event });
  addActivity(session, {
    type: 'notification',
    tool_name: event.tool_name,
    tool_input: { prompt: event.prompt },
    session_id: session.id,
    timestamp: Date.now(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
}

// --- Activity feed ---
function handleActivity(data, res) {
  const session = getSession(data.session_id, data.cwd);
  const isAgent = data.tool_name === 'Agent';

  // Track agent completion via PostToolUse/PostToolUseFailure
  if (isAgent) {
    const agentId = data.tool_use_id || randomBytes(8).toString('hex');
    trackAgentStop(session, { id: agentId, timestamp: Date.now() });
  }

  addActivity(session, {
    type: data.hook_event_name === 'PostToolUseFailure' ? 'failure' : 'success',
    tool_name: data.tool_name,
    tool_input: data.tool_input,
    tool_result: data.tool_result ? summarizeResult(data.tool_result) : null,
    session_id: session.id,
    timestamp: Date.now(),
  });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{}');
}

function addActivity(session, event) {
  session.activity.push(event);
  if (session.activity.length > MAX_ACTIVITY) session.activity.shift();
  broadcast({ type: 'activity', session_id: session.id, data: event });
}

// --- Decision from browser ---
function handleDecision(data, res) {
  const { requestId, allow, reason, response } = data;

  // Search across all sessions for the pending request
  const found = findPending(requestId);
  if (!found) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request not found or expired' }));
    return;
  }
  const { entry: p } = found;
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
  console.log(`\n  Remote Farmer (multi-session)`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Local:  http://localhost:${PORT}/?token=${TOKEN}`);
  console.log(`  Token:  ${TOKEN}`);
  console.log(`  Claims: ${CLAIMS_PATH}`);
  console.log(`\n  Hook endpoints:`);
  console.log(`    http://localhost:${PORT}/hooks/permission`);
  console.log(`    http://localhost:${PORT}/hooks/activity`);
  console.log(`    http://localhost:${PORT}/hooks/notification`);
  console.log(`    http://localhost:${PORT}/hooks/lifecycle`);
  console.log(`\n  SSE stream: /events?token=${TOKEN}`);
  console.log(`  Waiting for connections...\n`);
});
