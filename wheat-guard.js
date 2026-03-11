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

const toolInput = process.argv[2] || '{}';
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
if (rel.startsWith('output/') && !rel.endsWith('.gitkeep')) {
  const compilationPath = path.join(projectRoot, 'compilation.json');
  const claimsPath = path.join(projectRoot, 'claims.json');

  // Must exist
  if (!fs.existsSync(compilationPath)) {
    process.stderr.write(
      'BLOCKED: No compilation.json found. Run `node wheat-compiler.js` before generating output artifacts.\n' +
      'The Wheat pipeline requires: claims.json → compiler → compilation.json → artifact'
    );
    process.exit(2);
  }

  if (!fs.existsSync(claimsPath)) {
    process.stderr.write(
      'BLOCKED: No claims.json found. Run /init to bootstrap the sprint first.'
    );
    process.exit(2);
  }

  // Must not be stale
  const compilationMtime = fs.statSync(compilationPath).mtimeMs;
  const claimsMtime = fs.statSync(claimsPath).mtimeMs;

  if (claimsMtime > compilationMtime) {
    process.stderr.write(
      'BLOCKED: compilation.json is stale (claims.json was modified after last compilation).\n' +
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
      'BLOCKED: compilation.json is corrupted. Run `node wheat-compiler.js` to regenerate.'
    );
    process.exit(2);
  }
}

// ── Guard 2: claims.json writes must maintain meta fields ──
if (rel === 'claims.json' && input.content) {
  try {
    const newClaims = JSON.parse(input.content);
    if (!newClaims.meta || !newClaims.meta.question) {
      process.stderr.write(
        'BLOCKED: claims.json must have meta.question set. Run /init first.'
      );
      process.exit(2);
    }
    if (!newClaims.claims || !Array.isArray(newClaims.claims)) {
      process.stderr.write(
        'BLOCKED: claims.json must have a "claims" array.'
      );
      process.exit(2);
    }
  } catch {
    // Not valid JSON content — might be an Edit (partial), allow
  }
}

// All other writes — allow
process.exit(0);
