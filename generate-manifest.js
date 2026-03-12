#!/usr/bin/env node
/**
 * wheat-manifest.json generator
 *
 * Reads claims.json, compilation.json, and scans the repo directory structure
 * to produce a topic-map manifest. Zero npm dependencies.
 *
 * Usage:  node generate-manifest.js [--out wheat-manifest.json]
 *
 * Based on research claims r011 (single machine-readable manifest) and
 * r017 (topic map structure over file tree).
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = __dirname;

// --- CLI args ---
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const OUT_PATH = join(ROOT, arg('out', 'wheat-manifest.json'));

// --- Helpers ---

/** Recursively list files under dir, returning paths relative to ROOT. */
function walk(dir, filter) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // skip hidden dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      results.push(...walk(full, filter));
    } else {
      const rel = relative(ROOT, full);
      if (!filter || filter(rel, entry.name)) results.push(rel);
    }
  }
  return results;
}

/** Determine file type from its path. */
function classifyFile(relPath) {
  if (relPath.startsWith('prototypes/')) return 'prototype';
  if (relPath.startsWith('research/')) return 'research';
  if (relPath.startsWith('output/')) return 'output';
  if (relPath.startsWith('evidence/')) return 'evidence';
  if (relPath.startsWith('templates/')) return 'template';
  if (relPath.startsWith('examples/')) return 'example';
  if (relPath.startsWith('test/')) return 'test';
  if (relPath.startsWith('docs/')) return 'docs';
  // root-level files
  if (relPath.endsWith('.json')) return 'config';
  if (relPath.endsWith('.js') || relPath.endsWith('.mjs')) return 'script';
  if (relPath.endsWith('.md')) return 'docs';
  return 'other';
}

/** Compute highest evidence tier from a list of claims. */
function highestEvidence(claims) {
  const tiers = ['stated', 'web', 'documented', 'tested', 'production'];
  let max = 0;
  for (const c of claims) {
    const idx = tiers.indexOf(c.evidence);
    if (idx > max) max = idx;
  }
  return tiers[max];
}

/** Detect sprints: current + any in examples/. */
function detectSprints() {
  const sprints = {};

  // Current sprint
  const currentClaims = loadJSON(join(ROOT, 'claims.json'));
  if (currentClaims) {
    sprints['current'] = {
      question: currentClaims.meta?.question || '',
      phase: currentClaims.meta?.phase || 'unknown',
      claims_count: currentClaims.claims?.length || 0,
      path: '.'
    };
  }

  // Example/archived sprints
  const examplesDir = join(ROOT, 'examples');
  if (existsSync(examplesDir)) {
    for (const entry of readdirSync(examplesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sprintClaims = loadJSON(join(examplesDir, entry.name, 'claims.json'));
      if (sprintClaims) {
        sprints[entry.name] = {
          question: sprintClaims.meta?.question || '',
          phase: sprintClaims.meta?.phase || 'unknown',
          claims_count: sprintClaims.claims?.length || 0,
          path: `examples/${entry.name}`
        };
      }
    }
  }

  return sprints;
}

function loadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// --- Main ---
const t0 = performance.now();

const claims = loadJSON(join(ROOT, 'claims.json'));
const compilation = loadJSON(join(ROOT, 'compilation.json'));

if (!claims) {
  console.error('Error: claims.json not found or invalid at', join(ROOT, 'claims.json'));
  process.exit(1);
}

// 1. Build topic map from claims
const topicMap = {};
for (const claim of claims.claims) {
  const topic = claim.topic;
  if (!topicMap[topic]) {
    topicMap[topic] = { claims: [], files: new Set(), sprint: 'current', evidence_level: 'stated' };
  }
  topicMap[topic].claims.push(claim.id);
}

// Compute evidence levels per topic
for (const topic of Object.keys(topicMap)) {
  const topicClaims = claims.claims.filter(c => c.topic === topic);
  topicMap[topic].evidence_level = highestEvidence(topicClaims);
}

// 2. Scan current sprint directories for files (exclude examples/ — those are in sprints section)
const scanDirs = ['research', 'prototypes', 'output', 'evidence', 'templates', 'test', 'docs'];
const allFiles = {};

for (const dir of scanDirs) {
  const files = walk(join(ROOT, dir));
  for (const f of files) {
    const type = classifyFile(f);
    allFiles[f] = { topics: [], type };
  }
}

// Also include root-level scripts/configs
for (const entry of readdirSync(ROOT)) {
  if (entry.startsWith('.') || entry === 'node_modules') continue;
  const full = join(ROOT, entry);
  try {
    if (statSync(full).isFile()) {
      const type = classifyFile(entry);
      if (type !== 'other') {
        allFiles[entry] = { topics: [], type };
      }
    }
  } catch { /* skip */ }
}

// 3. Map files to topics using claim source artifacts and keyword heuristics
const topicKeywords = {
  'multi-session': ['session', 'server.mjs', 'hooks-config', 'dashboard.html', 'ws.mjs'],
  'multi-sprint': ['sprint', 'examples/'],
  'cartography': ['manifest', 'cartography', 'index'],
  'performance': ['performance', 'evaluation'],
  'compatibility': ['compat']
};

for (const [filePath, fileInfo] of Object.entries(allFiles)) {
  const lower = filePath.toLowerCase();

  // Heuristic: match file paths to topics via keywords
  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    if (keywords.some(kw => lower.includes(kw))) {
      if (!fileInfo.topics.includes(topic)) fileInfo.topics.push(topic);
    }
  }

  // Claims that reference files as artifacts
  for (const claim of claims.claims) {
    if (claim.source?.artifact && filePath.includes(claim.source.artifact.replace(/^.*\/prototypes\//, 'prototypes/'))) {
      if (!fileInfo.topics.includes(claim.topic)) {
        fileInfo.topics.push(claim.topic);
      }
    }
  }

  // Add files to topic map
  for (const topic of fileInfo.topics) {
    if (topicMap[topic]) {
      topicMap[topic].files.add(filePath);
    }
  }
}

// 4. Convert Sets to arrays for JSON serialization
for (const topic of Object.keys(topicMap)) {
  topicMap[topic].files = [...topicMap[topic].files].sort();
}

// 5. Detect sprints
const sprints = detectSprints();

// 6. Build final manifest — only include files with topic associations to stay compact
const topicFiles = {};
for (const [path, info] of Object.entries(allFiles)) {
  if (info.topics.length > 0) {
    topicFiles[path] = info;
  }
}

const manifest = {
  generated: new Date().toISOString(),
  generator: 'generate-manifest.js',
  claims_hash: compilation?.claims_hash || null,
  topics: topicMap,
  sprints,
  files: topicFiles
};

writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
const elapsed = (performance.now() - t0).toFixed(1);

// Summary
const topicCount = Object.keys(topicMap).length;
const fileCount = Object.keys(topicFiles).length;
const sprintCount = Object.keys(sprints).length;
const sizeBytes = Buffer.byteLength(JSON.stringify(manifest, null, 2));

console.log(`wheat-manifest.json generated in ${elapsed}ms`);
console.log(`  Topics: ${topicCount}  |  Files: ${fileCount}  |  Sprints: ${sprintCount}  |  Size: ${(sizeBytes / 1024).toFixed(1)}KB`);
