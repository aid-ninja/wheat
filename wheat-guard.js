#!/usr/bin/env node
/**
 * Wheat Guard — PreToolUse hook for Claude Code
 *
 * Blocks writes to output/ unless:
 *   1. compilation.json exists
 *   2. compilation.json is newer than claims.json (not stale)
 *   3. compilation status is "ready" (no unresolved conflicts)
 *
 * Also blocks writes to claims.json that skip required fields.
 *
 * Exit codes:
 *   0 = allow
 *   2 = block (with reason on stderr)
 */

const fs = require('fs');
const path = require('path');

// --help / -h
const _guardArgs = process.argv.slice(2);
if (_guardArgs.includes('--help') || _guardArgs.includes('-h')) {
  console.log(`Wheat Guard v0.1.0 — Pre-commit hook for claim integrity

Usage:
  node wheat-guard.js                 Run guard checks on claims.json
  node wheat-guard.js --help          Show this help message

Validates claims.json schema and checks for common issues before commits.
Install as a git hook or run manually.`);
  process.exit(0);
}

// ─── Load config ─────────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = path.join(__dirname, 'wheat.config.json');
  const defaults = {
    dirs: { output: 'output' },
    compiler: { claims: 'claims.json', compilation: 'compilation.json' },
  };
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    return {
      dirs: { ...defaults.dirs, ...(config.dirs || {}) },
      compiler: { ...defaults.compiler, ...(config.compiler || {}) },
    };
  } catch {
    return defaults;
  }
}

const config = loadConfig();

// Read tool input from stdin (Claude Code pipes $TOOL_INPUT there).
// Falls back to argv[2] for manual testing: node wheat-guard.js '{"file_path":"..."}'
let toolInput;
if (process.argv[2]) {
  toolInput = process.argv[2];
} else {
  try {
    toolInput = fs.readFileSync('/dev/stdin', 'utf8');
  } catch {
    toolInput = '{}';
  }
}

let input;
try {
  input = JSON.parse(toolInput);
} catch {
  // Not JSON — allow (might be a non-file tool call)
  process.exit(0);
}

const filePath = input.file_path || '';
const projectRoot = __dirname;

// Normalize to relative path for matching
const rel = path.relative(projectRoot, filePath);

// ── Guard 1: Writes to output/ require fresh compilation ──
if (rel.startsWith(config.dirs.output + '/') && !rel.endsWith('.gitkeep')) {
  const compilationPath = path.join(projectRoot, config.compiler.compilation);
  const claimsPath = path.join(projectRoot, config.compiler.claims);

  // Must exist
  if (!fs.existsSync(compilationPath)) {
    process.stderr.write(
      `BLOCKED: No ${config.compiler.compilation} found. Run \`node wheat-compiler.js\` before generating output artifacts.\n` +
      'The Wheat pipeline requires: claims.json → compiler → compilation.json → artifact'
    );
    process.exit(2);
  }

  if (!fs.existsSync(claimsPath)) {
    process.stderr.write(
      `BLOCKED: No ${config.compiler.claims} found. Run /init to bootstrap the sprint first.`
    );
    process.exit(2);
  }

  // Must not be stale
  const compilationMtime = fs.statSync(compilationPath).mtimeMs;
  const claimsMtime = fs.statSync(claimsPath).mtimeMs;

  if (claimsMtime > compilationMtime) {
    process.stderr.write(
      `BLOCKED: ${config.compiler.compilation} is stale (${config.compiler.claims} was modified after last compilation).\n` +
      'Run `node wheat-compiler.js` to recompile before generating output artifacts.'
    );
    process.exit(2);
  }

  // Must be ready
  try {
    const compilation = JSON.parse(fs.readFileSync(compilationPath, 'utf8'));
    if (compilation.status === 'blocked') {
      const errors = (compilation.errors || []).map(e => `  - ${e.message}`).join('\n');
      process.stderr.write(
        `BLOCKED: Compilation status is "blocked" — unresolved issues:\n${errors}\n` +
        'Fix these issues and recompile before generating output artifacts.'
      );
      process.exit(2);
    }
  } catch {
    process.stderr.write(
      `BLOCKED: ${config.compiler.compilation} is corrupted. Run \`node wheat-compiler.js\` to regenerate.`
    );
    process.exit(2);
  }
}

// ── Guard 2: claims.json writes must maintain meta fields ──
if (rel === config.compiler.claims && input.content) {
  try {
    const newClaims = JSON.parse(input.content);
    if (!newClaims.meta || !newClaims.meta.question) {
      process.stderr.write(
        `BLOCKED: ${config.compiler.claims} must have meta.question set. Run /init first.`
      );
      process.exit(2);
    }
    if (!newClaims.claims || !Array.isArray(newClaims.claims)) {
      process.stderr.write(
        `BLOCKED: ${config.compiler.claims} must have a "claims" array.`
      );
      process.exit(2);
    }
  } catch {
    // Not valid JSON content — might be an Edit (partial), allow
  }
}

// All other writes — allow
process.exit(0);
