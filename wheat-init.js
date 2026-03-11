#!/usr/bin/env node
/**
 * Wheat Init — Bootstrap Wheat into any repository
 *
 * Usage:
 *   node wheat-init.js              # Standard: compiler + commands + guard
 *   node wheat-init.js --full       # Full: + templates + directories + build-pdf
 *   node wheat-init.js --headless   # Headless: compiler only + empty claims.json
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

// --help / -h
if (args.includes('--help') || args.includes('-h')) {
  console.log(`Wheat Init v0.1.0 — Bootstrap a new research sprint

Usage:
  node wheat-init.js                  Interactive sprint initialization
  node wheat-init.js --help           Show this help message

Creates claims.json, CLAUDE.md, and directory structure for a new Wheat sprint.
Requires: Node.js >= 18`);
  process.exit(0);
}

const tier = args.includes('--headless') ? 'headless'
           : args.includes('--full') ? 'full'
           : 'standard';

const targetDir = args.find(a => !a.startsWith('--')) || process.cwd();
const resolvedTarget = path.resolve(targetDir);

// Ensure target directory exists
if (!fs.existsSync(resolvedTarget)) {
  fs.mkdirSync(resolvedTarget, { recursive: true });
}

console.log(`\nWheat Init — ${tier} tier`);
console.log(`Target: ${resolvedTarget}`);
console.log('='.repeat(50));

// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`  Created ${path.relative(resolvedTarget, dirPath)}/`);
  }
}

function copyFile(src, dest) {
  if (fs.existsSync(dest)) {
    console.log(`  Skipped ${path.relative(resolvedTarget, dest)} (already exists)`);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log(`  Copied  ${path.relative(resolvedTarget, dest)}`);
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`  Skipped ${path.relative(resolvedTarget, filePath)} (already exists)`);
    return;
  }
  fs.writeFileSync(filePath, content);
  console.log(`  Created ${path.relative(resolvedTarget, filePath)}`);
}

const wheatSrc = __dirname;

// ─── Step 1: Config ─────────────────────────────────────────────────────────
console.log('\n1. Configuration');
writeIfMissing(path.join(resolvedTarget, 'wheat.config.json'), JSON.stringify({
  dirs: { output: 'output', research: 'research', prototypes: 'prototypes', evidence: 'evidence', templates: 'templates' },
  compiler: { claims: 'claims.json', compilation: 'compilation.json' },
}, null, 2) + '\n');

// ─── Step 2: Compiler ───────────────────────────────────────────────────────
console.log('\n2. Compiler');
copyFile(path.join(wheatSrc, 'wheat-compiler.js'), path.join(resolvedTarget, 'wheat-compiler.js'));

// ─── Step 3: Empty claims.json ──────────────────────────────────────────────
console.log('\n3. Claims');
writeIfMissing(path.join(resolvedTarget, 'claims.json'), JSON.stringify({
  meta: { question: '', initiated: '', audience: [], phase: 'init', connectors: [] },
  claims: [],
}, null, 2) + '\n');

if (tier === 'headless') {
  console.log('\n✓ Headless setup complete.');
  console.log('  Run: node wheat-compiler.js --summary');
  process.exit(0);
}

// ─── Step 4: Guard ──────────────────────────────────────────────────────────
console.log('\n4. Guard');
copyFile(path.join(wheatSrc, 'wheat-guard.js'), path.join(resolvedTarget, 'wheat-guard.js'));

// ─── Step 5: .claude/ directory ─────────────────────────────────────────────
console.log('\n5. Claude Code integration');
const claudeDir = path.join(resolvedTarget, '.claude');
const commandsDir = path.join(claudeDir, 'commands');
ensureDir(commandsDir);

// Copy all commands
const commandFiles = fs.readdirSync(path.join(wheatSrc, '.claude', 'commands'))
  .filter(f => f.endsWith('.md'));
commandFiles.forEach(f => {
  copyFile(path.join(wheatSrc, '.claude', 'commands', f), path.join(commandsDir, f));
});

// Settings
writeIfMissing(path.join(claudeDir, 'settings.local.json'), JSON.stringify({
  permissions: {
    allow: [
      'Bash(node wheat-compiler.js:*)',
      'Bash(node build-pdf.js:*)',
      'Bash(npm install:*)',
      'Bash(open *)',
      'Bash(node wheat-guard.js:*)',
      'WebSearch',
    ],
  },
  hooks: {
    PreToolUse: [{
      matcher: 'Write|Edit',
      hooks: [{ type: 'command', command: 'node wheat-guard.js "$TOOL_INPUT"' }],
    }],
  },
}, null, 2) + '\n');

// CLAUDE.md template
writeIfMissing(path.join(resolvedTarget, 'CLAUDE.md'), `# Wheat — Research Sprint

> This file is auto-maintained by Wheat slash commands. Edit with care.

## Sprint

- **Question**: (run /init to set)
- **Audience**: (run /init to set)
- **Constraints**: (run /init to set)
- **Phase**: init

## Connectors

_No connectors configured. Use \`/connect\` to link org tools._

## Conventions

### Claims System (Bran IR)
- All findings are tracked as typed claims in \`claims.json\`
- Every slash command that produces findings MUST append claims
- Every slash command that produces output artifacts MUST run \`node wheat-compiler.js\` first
- Output artifacts consume \`compilation.json\`, never \`claims.json\` directly
- The compiler is the enforcement layer — if it says blocked, no artifact gets produced

### Claim Types
- \`constraint\` — hard requirements, non-negotiable boundaries
- \`factual\` — verifiable statements about the world
- \`estimate\` — projections, approximations, ranges
- \`risk\` — potential failure modes, concerns
- \`recommendation\` — proposed courses of action
- \`feedback\` — stakeholder input, opinions, direction changes

### Evidence Tiers (lowest → highest)
1. \`stated\` — stakeholder said it, no verification
2. \`web\` — found online, not independently verified
3. \`documented\` — in source code, official docs, or ADRs
4. \`tested\` — verified via prototype or benchmark
5. \`production\` — measured from live production systems

### Claim ID Prefixes
- \`d###\` — define phase (from /init)
- \`r###\` — research phase (from /research)
- \`p###\` — prototype phase (from /prototype)
- \`e###\` — evaluate phase (from /evaluate)
- \`f###\` — feedback phase (from /feedback)
- \`x###\` — challenge claims (from /challenge)
- \`w###\` — witness claims (from /witness)
- \`burn-###\` — synthetic claims (from /control-burn, always reverted)
- \`cal###\` — calibration claims (from /calibrate)
- \`<sprint-slug>-<prefix>###\` — merged claims (from /merge)

### Git Discipline
- Every slash command that modifies claims.json auto-commits
- Commit format: \`wheat: /<command> <summary> — added/updated <claim IDs>\`
- \`git log --oneline claims.json\` = the sprint event log
- Compilation certificate references the claims hash for reproducibility

### Output Artifacts
- HTML files are self-contained (inline CSS/JS, no external deps)
- Use the dark scroll-snap template for explainers and presentations
- Use the dashboard template for status and comparisons
- PDFs generated via \`node build-pdf.js <file.md>\`

### Directory Structure
- \`research/\` — topic explainers (HTML + MD)
- \`prototypes/\` — working proof-of-concepts
- \`evidence/\` — evaluation results and comparison dashboards
- \`output/\` — compiled artifacts (briefs, presentations, dashboards)
- \`templates/\` — HTML/CSS templates for artifact generation
`);

if (tier === 'standard') {
  console.log('\n✓ Standard setup complete.');
  console.log('  Run /init to start your first sprint.');
  process.exit(0);
}

// ─── Step 6: Full tier — templates + directories + build-pdf ────────────────
console.log('\n6. Templates & directories (full tier)');

const dirs = ['output', 'research', 'prototypes', 'evidence', 'templates'];
dirs.forEach(d => {
  ensureDir(path.join(resolvedTarget, d));
  writeIfMissing(path.join(resolvedTarget, d, '.gitkeep'), '');
});

// Copy templates if they exist in source
const templateDir = path.join(wheatSrc, 'templates');
if (fs.existsSync(templateDir)) {
  fs.readdirSync(templateDir).forEach(f => {
    copyFile(path.join(templateDir, f), path.join(resolvedTarget, 'templates', f));
  });
}

// Copy build-pdf.js
if (fs.existsSync(path.join(wheatSrc, 'build-pdf.js'))) {
  copyFile(path.join(wheatSrc, 'build-pdf.js'), path.join(resolvedTarget, 'build-pdf.js'));
}

// package.json
writeIfMissing(path.join(resolvedTarget, 'package.json'), JSON.stringify({
  name: 'wheat-sprint',
  version: '0.1.0',
  description: 'Research-driven development framework powered by Bran compilation',
  scripts: {
    compile: 'node wheat-compiler.js',
    'build-pdf': 'node build-pdf.js',
  },
  dependencies: {
    'md-to-pdf': '^5.2.4',
  },
}, null, 2) + '\n');

console.log('\n✓ Full setup complete.');
console.log('  Run: npm install && then /init to start your first sprint.');
process.exit(0);
