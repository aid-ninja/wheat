#!/usr/bin/env node
/**
 * build-replay.js — Extract git history frames and generate output/replay.html
 *
 * Pipeline:
 *   1. git log -- claims.json → list of commits
 *   2. git show <hash>:claims.json → snapshot per commit
 *   3. node wheat-compiler.js --input <tmp> --output <tmp-comp> → compile each
 *   4. node wheat-compiler.js --diff <prev> <curr> → delta between consecutive
 *   5. Auto-detect milestones (phase transitions, evidence jumps, conflicts)
 *   6. Inject FRAMES array into HTML template → output/replay.html
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const COMPILER = path.join(ROOT, 'wheat-compiler.js');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'replay.html');

// ─── Step 1: Get git log ────────────────────────────────────────────────────
function getCommits() {
  const raw = execSync(
    `git log --format='%H|%s|%aI' -- claims.json`,
    { cwd: ROOT, encoding: 'utf8' }
  ).trim();
  if (!raw) return [];
  return raw.split('\n').map(line => {
    const [hash, message, date] = line.split('|');
    return { hash, message, date };
  }).reverse(); // oldest first
}

// ─── Step 2–3: Extract and compile each snapshot ────────────────────────────
function extractAndCompile(commits) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wheat-replay-'));
  const compilations = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    const claimsFile = path.join(tmpDir, `claims-${i}.json`);
    const compFile = path.join(tmpDir, `comp-${i}.json`);

    try {
      const claimsRaw = execSync(
        `git show ${commit.hash}:claims.json`,
        { cwd: ROOT, encoding: 'utf8' }
      );
      fs.writeFileSync(claimsFile, claimsRaw);
    } catch {
      // claims.json might not exist at this commit (initial creation?)
      compilations.push(null);
      continue;
    }

    try {
      execSync(
        `node ${JSON.stringify(COMPILER)} --input ${JSON.stringify(claimsFile)} --output ${JSON.stringify(compFile)}`,
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
      );
      const comp = JSON.parse(fs.readFileSync(compFile, 'utf8'));
      compilations.push(comp);
    } catch {
      compilations.push(null);
    }
  }

  return { tmpDir, compilations };
}

// ─── Step 4: Compute deltas ─────────────────────────────────────────────────
function computeDeltas(compilations, tmpDir) {
  const deltas = [null]; // first frame has no delta

  for (let i = 1; i < compilations.length; i++) {
    if (!compilations[i - 1] || !compilations[i]) {
      deltas.push(null);
      continue;
    }

    const prevFile = path.join(tmpDir, `comp-${i - 1}.json`);
    const currFile = path.join(tmpDir, `comp-${i}.json`);

    try {
      const raw = execSync(
        `node ${JSON.stringify(COMPILER)} --diff ${JSON.stringify(prevFile)} ${JSON.stringify(currFile)}`,
        { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
      );
      deltas.push(JSON.parse(raw));
    } catch {
      deltas.push(null);
    }
  }

  return deltas;
}

// ─── Step 5: Detect milestones ──────────────────────────────────────────────
function detectMilestones(compilations, deltas) {
  const milestones = [];

  for (let i = 0; i < compilations.length; i++) {
    const comp = compilations[i];
    const delta = deltas[i];
    const events = [];

    if (!comp) { milestones.push(null); continue; }

    if (delta) {
      // Phase transition
      if (delta.meta_changes?.phase) {
        events.push(`Phase: ${delta.meta_changes.phase.from || 'init'} -> ${delta.meta_changes.phase.to}`);
      }

      // Large batch of new claims
      if (delta.new_claims?.length >= 5) {
        events.push(`+${delta.new_claims.length} claims added`);
      }

      // Evidence upgrades in coverage
      const evidenceJumps = (delta.coverage_changes || []).filter(
        c => c.type === 'changed' && c.changes?.max_evidence
      );
      if (evidenceJumps.length > 0) {
        evidenceJumps.forEach(j => {
          events.push(`${j.topic}: ${j.changes.max_evidence.from} -> ${j.changes.max_evidence.to}`);
        });
      }

      // New conflicts
      if (delta.conflict_changes?.new_unresolved?.length > 0) {
        events.push(`${delta.conflict_changes.new_unresolved.length} new conflict(s)`);
      }

      // Conflicts resolved
      if (delta.conflict_changes?.new_resolved?.length > 0) {
        events.push(`${delta.conflict_changes.new_resolved.length} conflict(s) resolved`);
      }

      // New topics
      const newTopics = (delta.coverage_changes || []).filter(c => c.type === 'added');
      if (newTopics.length > 0) {
        events.push(`New topic(s): ${newTopics.map(t => t.topic).join(', ')}`);
      }

      // Status change (blocked -> ready or vice versa)
      if (delta.meta_changes?.status) {
        events.push(`Status: ${delta.meta_changes.status.from} -> ${delta.meta_changes.status.to}`);
      }
    }

    // First frame
    if (i === 0 && comp) {
      events.push('Sprint begins');
    }

    milestones.push(events.length > 0 ? events.join(' | ') : null);
  }

  return milestones;
}

// ─── Step 5b: Detect batch commits ──────────────────────────────────────────
const BATCH_THRESHOLD = 3; // commits adding more than this many claims are "batch"

function isBatchCommit(delta) {
  if (!delta) return false;
  return (delta.new_claims || []).length > BATCH_THRESHOLD;
}

// ─── Step 6: Build FRAMES array (with hybrid sub-framing) ───────────────────
function buildFrames(commits, compilations, deltas, milestones) {
  const frames = [];
  // Track the previous compilation's claim set for sub-frame interpolation
  let prevClaimIds = new Set();

  for (let i = 0; i < commits.length; i++) {
    if (!compilations[i]) continue;

    const comp = compilations[i];
    const delta = deltas[i];
    const commitMeta = {
      hash: commits[i].hash.slice(0, 7),
      message: commits[i].message,
      date: commits[i].date,
    };

    const allClaims = (comp.resolved_claims || []).map(c => ({
      id: c.id,
      type: c.type,
      topic: c.topic,
      content: c.content,
      evidence: c.evidence,
      status: c.status,
    }));

    const baseStats = {
      total: comp.sprint_meta?.total_claims || 0,
      active: comp.sprint_meta?.active_claims || 0,
      conflicted: comp.sprint_meta?.conflicted_claims || 0,
      superseded: comp.sprint_meta?.superseded_claims || 0,
      topics: Object.keys(comp.coverage || {}).length,
      phase: comp.sprint_meta?.phase || 'init',
      status: comp.status || 'unknown',
    };

    const baseDelta = delta ? {
      added: delta.new_claims || [],
      removed: delta.removed_claims || [],
      upgraded: (delta.coverage_changes || [])
        .filter(c => c.type === 'changed' && c.changes?.max_evidence)
        .map(c => ({
          topic: c.topic,
          from: c.changes.max_evidence.from,
          to: c.changes.max_evidence.to,
        })),
      statusChanges: delta.status_changes || [],
      newTopics: (delta.coverage_changes || [])
        .filter(c => c.type === 'added')
        .map(c => c.topic),
    } : null;

    const isBatch = isBatchCommit(delta);

    if (isBatch && baseDelta) {
      // ── Hybrid sub-framing: split batch into incremental sub-frames ──
      const addedIds = baseDelta.added;
      const removedIds = new Set(baseDelta.removed);

      // Group added claims by topic for narrative coherence
      const addedByTopic = {};
      addedIds.forEach(id => {
        const claim = allClaims.find(c => c.id === id);
        if (claim) {
          if (!addedByTopic[claim.topic]) addedByTopic[claim.topic] = [];
          addedByTopic[claim.topic].push(id);
        }
      });

      // Build sub-frame groups: ~1-3 claims per sub-frame, grouped by topic
      const subGroups = [];
      Object.keys(addedByTopic).sort().forEach(topic => {
        const ids = addedByTopic[topic];
        // Chunk into groups of 1-3
        for (let j = 0; j < ids.length; j += 3) {
          subGroups.push(ids.slice(j, j + 3));
        }
      });

      // Start with the previous frame's claims (before this batch)
      let runningClaimIds = new Set(prevClaimIds);
      // Remove any claims that this commit removes
      removedIds.forEach(id => runningClaimIds.delete(id));

      const commitFrameStart = frames.length;
      const totalSubFrames = subGroups.length;

      for (let s = 0; s < subGroups.length; s++) {
        const subAddedIds = subGroups[s];
        subAddedIds.forEach(id => runningClaimIds.add(id));

        // Filter allClaims to only those visible at this sub-frame
        const visibleClaims = allClaims.filter(c => runningClaimIds.has(c.id));

        // Compute sub-frame coverage from visible claims
        const subCoverage = computeSubCoverage(visibleClaims, comp.coverage || {});

        // Compute sub-frame stats
        const subStats = {
          ...baseStats,
          total: visibleClaims.length,
          active: visibleClaims.filter(c => c.status === 'active').length,
          topics: Object.keys(subCoverage).length,
        };

        // Sub-frame delta: only the claims added in THIS sub-step
        const isFirstSub = s === 0;
        const subDelta = {
          added: subAddedIds,
          removed: isFirstSub ? baseDelta.removed : [],
          upgraded: isFirstSub ? baseDelta.upgraded : [],
          statusChanges: isFirstSub ? baseDelta.statusChanges : [],
          newTopics: isFirstSub ? baseDelta.newTopics : [],
        };

        const frame = {
          index: frames.length,
          commit: commitMeta,
          claims: visibleClaims,
          coverage: subCoverage,
          stats: subStats,
          conflicts: {
            resolved: (comp.conflict_graph?.resolved || []).length,
            unresolved: (comp.conflict_graph?.unresolved || []).length,
          },
          delta: subDelta,
          milestone: s === 0 ? milestones[i] : null,
          // ── Hybrid framing metadata ──
          subframe: true,
          parentFrame: commitFrameStart,
          subIndex: s,
          subTotal: totalSubFrames,
          batchCommit: true,
        };

        frames.push(frame);
      }
    } else {
      // ── Regular (non-batch) frame ──
      const frame = {
        index: frames.length,
        commit: commitMeta,
        claims: allClaims,
        coverage: comp.coverage || {},
        stats: baseStats,
        conflicts: {
          resolved: (comp.conflict_graph?.resolved || []).length,
          unresolved: (comp.conflict_graph?.unresolved || []).length,
        },
        delta: baseDelta,
        milestone: milestones[i],
        subframe: false,
        parentFrame: null,
        subIndex: null,
        subTotal: null,
        batchCommit: false,
      };

      frames.push(frame);
    }

    // Track claim IDs for next iteration's sub-framing
    prevClaimIds = new Set(allClaims.map(c => c.id));
  }

  return frames;
}

// Helper: compute coverage for a subset of claims, using the full compilation's
// coverage as a reference for status thresholds
function computeSubCoverage(visibleClaims, fullCoverage) {
  const coverage = {};
  visibleClaims.forEach(c => {
    if (!coverage[c.topic]) {
      // Use the full coverage entry as a template if available
      const ref = fullCoverage[c.topic];
      coverage[c.topic] = {
        claims: 0,
        max_evidence: c.evidence,
        status: ref?.status || 'weak',
      };
    }
    coverage[c.topic].claims++;
    // Track highest evidence tier
    const tiers = ['stated', 'web', 'documented', 'tested', 'production'];
    const curIdx = tiers.indexOf(coverage[c.topic].max_evidence);
    const newIdx = tiers.indexOf(c.evidence);
    if (newIdx > curIdx) coverage[c.topic].max_evidence = c.evidence;
  });
  return coverage;
}

// ─── Step 7: Generate HTML ──────────────────────────────────────────────────
function generateHTML(frames) {
  const framesJSON = JSON.stringify(frames, null, 2);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sprint Replay — Wheat</title>
<style>
  :root {
    --bg-dark: #0f172a;
    --bg-card: #1e293b;
    --bg-card-hover: #263548;
    --accent: #3b82f6;
    --accent-light: #60a5fa;
    --green: #22c55e;
    --green-dim: rgba(34,197,94,0.12);
    --orange: #f59e0b;
    --orange-dim: rgba(245,158,11,0.12);
    --red: #ef4444;
    --red-dim: rgba(239,68,68,0.12);
    --purple: #a78bfa;
    --purple-dim: rgba(167,139,250,0.12);
    --pink: #f472b6;
    --pink-dim: rgba(244,114,182,0.12);
    --text: #f1f5f9;
    --text-muted: #94a3b8;
    --text-dim: #64748b;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
    background: var(--bg-dark);
    color: var(--text);
    font-size: 11pt;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* ─── Top bar: title + scrubber ─────────────────────────────────────── */
  .top-bar {
    padding: 16px 24px 12px;
    background: linear-gradient(180deg, rgba(15,23,42,1) 0%, rgba(15,23,42,0.95) 100%);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
    position: relative;
    z-index: 10;
  }

  .top-bar::before {
    content: '';
    position: absolute;
    top: 0; right: 0;
    width: 40%;
    height: 100%;
    background: radial-gradient(ellipse at top right, rgba(59,130,246,0.06) 0%, transparent 70%);
    pointer-events: none;
  }

  .top-title {
    font-size: 14pt;
    font-weight: 700;
    color: #fff;
    margin-bottom: 8px;
    letter-spacing: -0.01em;
  }

  .top-title span {
    color: var(--accent-light);
    font-weight: 400;
  }

  .scrubber-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .btn {
    background: var(--bg-card);
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text);
    border-radius: 6px;
    padding: 6px 12px;
    cursor: pointer;
    font-size: 10pt;
    font-family: inherit;
    transition: background 0.15s;
    flex-shrink: 0;
  }

  .btn:hover { background: var(--bg-card-hover); }
  .btn.active { background: var(--accent); border-color: var(--accent); }

  #playBtn {
    width: 36px;
    height: 36px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14pt;
    border-radius: 50%;
  }

  .scrubber-track {
    flex: 1;
    position: relative;
  }

  #scrubber {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: var(--bg-card);
    outline: none;
    cursor: pointer;
  }

  #scrubber::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-light);
    cursor: pointer;
    border: 2px solid var(--bg-dark);
    box-shadow: 0 0 8px rgba(59,130,246,0.4);
    transition: transform 0.1s;
  }

  #scrubber::-webkit-slider-thumb:hover {
    transform: scale(1.2);
  }

  #scrubber::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent-light);
    cursor: pointer;
    border: 2px solid var(--bg-dark);
  }

  .scrubber-info {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    font-size: 9pt;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .frame-counter {
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--accent-light);
    font-size: 10pt;
    min-width: 70px;
  }

  .speed-btn {
    padding: 4px 8px;
    font-size: 9pt;
    min-width: 32px;
    text-align: center;
  }

  .commit-msg {
    margin-top: 6px;
    font-size: 9pt;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', monospace;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ─── Sub-frame indicator ──────────────────────────────────────── */
  .subframe-indicator {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: 8px;
    font-size: 8pt;
    color: var(--purple);
    font-weight: 600;
  }

  .subframe-badge {
    background: var(--purple-dim);
    color: var(--purple);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 7.5pt;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .subframe-dots {
    display: inline-flex;
    gap: 3px;
    align-items: center;
  }

  .subframe-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--text-dim);
    transition: background 0.2s;
  }

  .subframe-dot.active {
    background: var(--purple);
    box-shadow: 0 0 4px rgba(167,139,250,0.5);
  }

  .subframe-dot.past {
    background: var(--text-muted);
  }

  #nextCommitBtn {
    font-size: 8pt;
    padding: 4px 10px;
    background: var(--purple-dim);
    border-color: rgba(167,139,250,0.3);
    color: var(--purple);
  }

  #nextCommitBtn:hover {
    background: rgba(167,139,250,0.2);
  }

  /* Batch markers on scrubber */
  .batch-marker {
    position: absolute;
    top: -2px;
    height: 10px;
    background: rgba(167,139,250,0.25);
    border-radius: 2px;
    pointer-events: none;
  }

  /* ─── Milestone markers on scrubber ────────────────────────────────── */
  .milestone-markers {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 6px;
    pointer-events: none;
  }

  .milestone-marker {
    position: absolute;
    top: -3px;
    width: 4px;
    height: 12px;
    background: var(--orange);
    border-radius: 2px;
    transform: translateX(-50%);
    opacity: 0.7;
  }

  /* ─── Main content area ────────────────────────────────────────────── */
  .main-area {
    flex: 1;
    display: flex;
    overflow: hidden;
    min-height: 0;
  }

  /* ─── Left panel: claims ───────────────────────────────────────────── */
  .panel-left {
    width: 50%;
    overflow-y: auto;
    padding: 16px 20px;
    border-right: 1px solid rgba(255,255,255,0.06);
  }

  .panel-left::-webkit-scrollbar { width: 6px; }
  .panel-left::-webkit-scrollbar-track { background: transparent; }
  .panel-left::-webkit-scrollbar-thumb { background: var(--text-dim); border-radius: 3px; }

  .panel-left-title {
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent-light);
    margin-bottom: 12px;
  }

  .topic-group {
    margin-bottom: 16px;
  }

  .topic-header {
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 4px 0;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    margin-bottom: 6px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .topic-count {
    font-size: 8pt;
    color: var(--text-dim);
    font-weight: 400;
  }

  .claim-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    margin-bottom: 2px;
    transition: opacity 0.3s ease, transform 0.3s ease, background-color 0.4s ease;
    font-size: 9.5pt;
    position: relative;
  }

  .claim-item:hover {
    background: rgba(255,255,255,0.03);
  }

  .claim-id {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 8pt;
    color: var(--text-dim);
    min-width: 36px;
    padding-top: 1px;
    flex-shrink: 0;
  }

  .claim-content {
    flex: 1;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .claim-evidence {
    font-size: 7.5pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 3px;
    flex-shrink: 0;
  }

  .evidence-stated { color: var(--text-dim); background: rgba(100,116,139,0.15); }
  .evidence-web { color: var(--orange); background: var(--orange-dim); }
  .evidence-documented { color: var(--purple); background: var(--purple-dim); }
  .evidence-tested { color: var(--green); background: var(--green-dim); }
  .evidence-production { color: var(--accent-light); background: rgba(59,130,246,0.12); }

  /* Delta badges */
  .badge-new {
    background: var(--green-dim);
    border-left: 3px solid var(--green);
  }

  .badge-upgraded {
    animation: pulse-amber 0.6s ease-out;
  }

  .badge-removed {
    opacity: 0.3;
    transform: scale(0.95);
    text-decoration: line-through;
  }

  /* Claim entry animation */
  .claim-enter {
    animation: claimAppear 0.3s ease-out forwards;
  }

  @keyframes claimAppear {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulse-amber {
    0% { background-color: var(--orange-dim); }
    50% { background-color: rgba(245,158,11,0.25); }
    100% { background-color: transparent; }
  }

  /* ─── Right panel: coverage + stats ────────────────────────────────── */
  .panel-right {
    width: 50%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-section {
    padding: 16px 20px;
  }

  .panel-section + .panel-section {
    border-top: 1px solid rgba(255,255,255,0.06);
  }

  .section-title {
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--accent-light);
    margin-bottom: 12px;
  }

  /* Coverage map */
  .coverage-section {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .coverage-section::-webkit-scrollbar { width: 6px; }
  .coverage-section::-webkit-scrollbar-track { background: transparent; }
  .coverage-section::-webkit-scrollbar-thumb { background: var(--text-dim); border-radius: 3px; }

  .coverage-bar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .coverage-topic {
    font-size: 8.5pt;
    color: var(--text-muted);
    width: 130px;
    flex-shrink: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
  }

  .coverage-bar-track {
    flex: 1;
    height: 14px;
    background: rgba(255,255,255,0.04);
    border-radius: 4px;
    overflow: hidden;
    position: relative;
  }

  .coverage-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.4s ease-out;
    display: flex;
  }

  .coverage-segment {
    height: 100%;
    transition: width 0.4s ease-out;
  }

  .coverage-status {
    font-size: 7.5pt;
    font-weight: 600;
    text-transform: uppercase;
    width: 60px;
    flex-shrink: 0;
  }

  .status-weak { color: var(--red); }
  .status-moderate { color: var(--orange); }
  .status-strong { color: var(--green); }

  /* Stats */
  .stats-section {
    flex-shrink: 0;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
  }

  .stat-card {
    background: var(--bg-card);
    border-radius: 10px;
    padding: 14px 16px;
    border: 1px solid rgba(255,255,255,0.06);
  }

  .stat-label {
    font-size: 8pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    margin-bottom: 4px;
  }

  .stat-value {
    font-size: 20pt;
    font-weight: 700;
    color: var(--text);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }

  .stat-delta {
    font-size: 8pt;
    font-weight: 600;
    margin-left: 4px;
  }

  .stat-delta.positive { color: var(--green); }
  .stat-delta.negative { color: var(--red); }
  .stat-delta.neutral { color: var(--text-dim); }

  /* Evidence distribution mini-bar */
  .evidence-dist {
    display: flex;
    gap: 2px;
    margin-top: 8px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
  }

  .evidence-dist-seg {
    height: 100%;
    transition: width 0.4s ease-out;
    min-width: 2px;
  }

  .evidence-dist-legend {
    display: flex;
    gap: 10px;
    margin-top: 6px;
    flex-wrap: wrap;
  }

  .evidence-legend-item {
    font-size: 7.5pt;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .evidence-legend-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  /* ─── Bottom delta bar ─────────────────────────────────────────────── */
  .delta-bar {
    padding: 10px 24px;
    background: var(--bg-card);
    border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 9pt;
    color: var(--text-muted);
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 40px;
  }

  .delta-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .delta-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .milestone-tag {
    background: var(--orange-dim);
    color: var(--orange);
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 8pt;
    font-weight: 600;
  }

  /* ─── Keyboard hint ────────────────────────────────────────────────── */
  .kbd-hint {
    position: fixed;
    bottom: 52px;
    right: 16px;
    font-size: 7.5pt;
    color: var(--text-dim);
    opacity: 0.5;
  }

  kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 3px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 7pt;
    background: rgba(255,255,255,0.05);
  }
</style>
</head>
<body>

<!-- Top Bar -->
<div class="top-bar">
  <div class="top-title">Sprint Replay <span>— Wheat live visualization</span></div>
  <div class="scrubber-row">
    <button id="playBtn" class="btn" title="Play/Pause (Space)">&#9654;</button>
    <div class="scrubber-track">
      <input type="range" id="scrubber" min="0" max="0" step="1" value="0">
      <div class="milestone-markers" id="milestoneMarkers"></div>
    </div>
    <div class="scrubber-info">
      <span class="frame-counter" id="frameCounter">0 / 0</span>
      <span id="subframeIndicator"></span>
      <button class="btn" id="nextCommitBtn" title="Skip to next commit (N)" style="display:none">Next Commit &#9654;&#9654;</button>
      <button class="btn speed-btn" id="speedBtn" title="Playback speed">1x</button>
    </div>
  </div>
  <div class="commit-msg" id="commitMsg">—</div>
</div>

<!-- Main panels -->
<div class="main-area">
  <div class="panel-left">
    <div class="panel-left-title">Claims</div>
    <div id="claimsContainer"></div>
  </div>
  <div class="panel-right">
    <div class="panel-section coverage-section">
      <div class="section-title">Coverage Map</div>
      <div id="coverageContainer"></div>
    </div>
    <div class="panel-section stats-section">
      <div class="section-title">Stats</div>
      <div class="stats-grid" id="statsGrid">
        <div class="stat-card">
          <div class="stat-label">Claims</div>
          <div><span class="stat-value" id="statClaims">0</span><span class="stat-delta" id="statClaimsDelta"></span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Topics</div>
          <div><span class="stat-value" id="statTopics">0</span><span class="stat-delta" id="statTopicsDelta"></span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Conflicts</div>
          <div><span class="stat-value" id="statConflicts">0</span></div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Phase</div>
          <div><span class="stat-value" id="statPhase" style="font-size:13pt;">—</span></div>
        </div>
      </div>
      <div class="evidence-dist" id="evidenceDist"></div>
      <div class="evidence-dist-legend" id="evidenceLegend"></div>
    </div>
  </div>
</div>

<!-- Delta bar -->
<div class="delta-bar" id="deltaBar">
  <span>Navigate to a frame to see changes</span>
</div>

<div class="kbd-hint">
  <kbd>&larr;</kbd> <kbd>&rarr;</kbd> step &nbsp;
  <kbd>Space</kbd> play/pause &nbsp;
  <kbd>N</kbd> next commit &nbsp;
  <kbd>Home</kbd> <kbd>End</kbd> jump
</div>

<script>
// ─── FRAMES DATA (injected by build-replay.js) ──────────────────────────────
const FRAMES = __FRAMES_PLACEHOLDER__;

// ─── State ───────────────────────────────────────────────────────────────────
let currentFrame = 0;
let playing = false;
let speed = 1; // frames per second
let lastFrameTime = 0;
let animFrameId = null;

// Animated counter targets
const counterState = {
  claims: { current: 0, target: 0 },
  topics: { current: 0, target: 0 },
  conflicts: { current: 0, target: 0 },
};

// Evidence colors
const EVIDENCE_COLORS = {
  stated: '#64748b',
  web: '#f59e0b',
  documented: '#a78bfa',
  tested: '#22c55e',
  production: '#3b82f6',
};

const EVIDENCE_ORDER = ['stated', 'web', 'documented', 'tested', 'production'];

// ─── Init ────────────────────────────────────────────────────────────────────
const scrubber = document.getElementById('scrubber');
const playBtn = document.getElementById('playBtn');
const speedBtn = document.getElementById('speedBtn');
const frameCounter = document.getElementById('frameCounter');
const commitMsg = document.getElementById('commitMsg');
const claimsContainer = document.getElementById('claimsContainer');
const coverageContainer = document.getElementById('coverageContainer');
const deltaBar = document.getElementById('deltaBar');
const milestoneMarkers = document.getElementById('milestoneMarkers');
const subframeIndicator = document.getElementById('subframeIndicator');
const nextCommitBtn = document.getElementById('nextCommitBtn');

// Pre-compute commit boundaries for "next commit" navigation
const commitBoundaries = []; // indices where a new commit starts
{
  let lastHash = null;
  FRAMES.forEach((f, i) => {
    if (f.commit.hash !== lastHash) {
      commitBoundaries.push(i);
      lastHash = f.commit.hash;
    }
  });
}

if (FRAMES.length > 0) {
  scrubber.max = FRAMES.length - 1;

  // Place milestone markers
  FRAMES.forEach((f, i) => {
    if (f.milestone) {
      const pct = (i / (FRAMES.length - 1)) * 100;
      const marker = document.createElement('div');
      marker.className = 'milestone-marker';
      marker.style.left = pct + '%';
      marker.title = f.milestone;
      milestoneMarkers.appendChild(marker);
    }
  });

  // Place batch markers on scrubber (show expanded regions)
  let batchStart = null;
  FRAMES.forEach((f, i) => {
    if (f.subframe && batchStart === null) {
      batchStart = i;
    }
    if (batchStart !== null && (!f.subframe || i === FRAMES.length - 1)) {
      const end = f.subframe ? i : i - 1;
      const startPct = (batchStart / (FRAMES.length - 1)) * 100;
      const endPct = (end / (FRAMES.length - 1)) * 100;
      const marker = document.createElement('div');
      marker.className = 'batch-marker';
      marker.style.left = startPct + '%';
      marker.style.width = Math.max(endPct - startPct, 1) + '%';
      milestoneMarkers.appendChild(marker);
      batchStart = null;
    }
  });

  render(FRAMES[0]);
}

// ─── Scrubber events ─────────────────────────────────────────────────────────
scrubber.addEventListener('input', () => {
  if (playing) togglePlay(); // auto-pause on scrub
  currentFrame = parseInt(scrubber.value);
  render(FRAMES[currentFrame]);
});

playBtn.addEventListener('click', togglePlay);

nextCommitBtn.addEventListener('click', goToNextCommit);

const SPEEDS = [1, 2, 4];
let speedIdx = 0;
speedBtn.addEventListener('click', () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  speed = SPEEDS[speedIdx];
  speedBtn.textContent = speed + 'x';
});

// ─── Keyboard ────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

  switch(e.key) {
    case ' ':
    case 'k':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowLeft':
    case 'j':
      e.preventDefault();
      if (playing) togglePlay();
      goToFrame(currentFrame - 1);
      break;
    case 'ArrowRight':
    case 'l':
      e.preventDefault();
      if (playing) togglePlay();
      goToFrame(currentFrame + 1);
      break;
    case 'n':
    case 'N':
      e.preventDefault();
      if (playing) togglePlay();
      goToNextCommit();
      break;
    case 'p':
    case 'P':
      e.preventDefault();
      if (playing) togglePlay();
      goToPrevCommit();
      break;
    case 'Home':
      e.preventDefault();
      if (playing) togglePlay();
      goToFrame(0);
      break;
    case 'End':
      e.preventDefault();
      if (playing) togglePlay();
      goToFrame(FRAMES.length - 1);
      break;
  }
});

function goToFrame(idx) {
  if (idx < 0 || idx >= FRAMES.length) return;
  currentFrame = idx;
  scrubber.value = idx;
  updateScrubberFill();
  render(FRAMES[idx]);
}

function goToNextCommit() {
  // Find the next commit boundary after current frame
  for (let i = 0; i < commitBoundaries.length; i++) {
    if (commitBoundaries[i] > currentFrame) {
      goToFrame(commitBoundaries[i]);
      return;
    }
  }
  // If at or past last boundary, go to end
  goToFrame(FRAMES.length - 1);
}

function goToPrevCommit() {
  // Find the commit boundary at or before the current frame, then go to the one before that
  for (let i = commitBoundaries.length - 1; i >= 0; i--) {
    if (commitBoundaries[i] < currentFrame) {
      // If we're in the middle of a batch, go to the start of this commit
      const frame = FRAMES[currentFrame];
      if (frame.subframe && frame.parentFrame === commitBoundaries[i]) {
        // Already at the start of this commit's sub-frames; go to previous commit
        if (i > 0) { goToFrame(commitBoundaries[i - 1]); return; }
        goToFrame(0); return;
      }
      goToFrame(commitBoundaries[i]);
      return;
    }
  }
  goToFrame(0);
}

function togglePlay() {
  playing = !playing;
  playBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
  playBtn.classList.toggle('active', playing);
  if (playing) {
    lastFrameTime = performance.now();
    animFrameId = requestAnimationFrame(playLoop);
  } else if (animFrameId) {
    cancelAnimationFrame(animFrameId);
  }
}

function playLoop(timestamp) {
  if (!playing) return;
  const elapsed = timestamp - lastFrameTime;
  const interval = 1000 / speed;

  if (elapsed >= interval) {
    lastFrameTime = timestamp;
    if (currentFrame < FRAMES.length - 1) {
      currentFrame++;
      scrubber.value = currentFrame;
      updateScrubberFill();
      render(FRAMES[currentFrame]);
    } else {
      togglePlay(); // stop at end
      return;
    }
  }

  animFrameId = requestAnimationFrame(playLoop);
}

function updateScrubberFill() {
  const pct = FRAMES.length > 1 ? (currentFrame / (FRAMES.length - 1)) * 100 : 0;
  scrubber.style.background = \`linear-gradient(to right, var(--accent) 0%, var(--accent) \${pct}%, var(--bg-card) \${pct}%, var(--bg-card) 100%)\`;
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render(frame) {
  if (!frame) return;

  // Update scrubber fill
  updateScrubberFill();

  // Frame counter + commit message
  frameCounter.textContent = (frame.index + 1) + ' / ' + FRAMES.length;
  commitMsg.textContent = frame.commit.hash + ' — ' + frame.commit.message;

  // Sub-frame indicator
  if (frame.subframe) {
    let dotsHtml = '';
    for (let d = 0; d < frame.subTotal; d++) {
      const cls = d < frame.subIndex ? 'past' : d === frame.subIndex ? 'active' : '';
      dotsHtml += '<span class="subframe-dot ' + cls + '"></span>';
    }
    subframeIndicator.innerHTML =
      '<span class="subframe-badge">BATCH</span>' +
      '<span class="subframe-dots">' + dotsHtml + '</span>' +
      '<span style="font-size:8pt;color:var(--purple)">' + (frame.subIndex + 1) + '/' + frame.subTotal + '</span>';
    nextCommitBtn.style.display = '';
  } else {
    subframeIndicator.innerHTML = '';
    nextCommitBtn.style.display = 'none';
  }

  // Claims panel
  renderClaims(frame);

  // Coverage map
  renderCoverage(frame);

  // Stats
  renderStats(frame);

  // Delta bar
  renderDelta(frame);
}

// ─── Claims Panel ────────────────────────────────────────────────────────────
function renderClaims(frame) {
  const groups = {};
  frame.claims.forEach(c => {
    if (!groups[c.topic]) groups[c.topic] = [];
    groups[c.topic].push(c);
  });

  const addedSet = new Set(frame.delta?.added || []);
  const removedSet = new Set(frame.delta?.removed || []);

  let html = '';
  const sortedTopics = Object.keys(groups).sort();

  sortedTopics.forEach(topic => {
    const claims = groups[topic];
    html += '<div class="topic-group">';
    html += '<div class="topic-header"><span>' + escapeHtml(topic) + '</span><span class="topic-count">' + claims.length + '</span></div>';

    claims.forEach((c, idx) => {
      const isNew = addedSet.has(c.id);
      const classes = ['claim-item'];
      if (isNew) {
        classes.push('badge-new', 'claim-enter');
      }

      const delay = isNew ? ' style="animation-delay:' + (idx * 50) + 'ms"' : '';

      html += '<div class="' + classes.join(' ') + '"' + delay + '>';
      html += '<span class="claim-id">' + c.id + '</span>';
      html += '<span class="claim-content">' + escapeHtml(truncate(c.content, 80)) + '</span>';
      html += '<span class="claim-evidence evidence-' + c.evidence + '">' + c.evidence + '</span>';
      html += '</div>';
    });

    html += '</div>';
  });

  // Show removed claims at bottom if any
  if (removedSet.size > 0) {
    html += '<div class="topic-group">';
    html += '<div class="topic-header" style="color:var(--red)"><span>Removed</span></div>';
    removedSet.forEach(id => {
      html += '<div class="claim-item badge-removed">';
      html += '<span class="claim-id">' + id + '</span>';
      html += '<span class="claim-content" style="color:var(--text-dim)">removed in this frame</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  claimsContainer.innerHTML = html;
}

// ─── Coverage Map ────────────────────────────────────────────────────────────
function renderCoverage(frame) {
  const coverage = frame.coverage;
  const topics = Object.keys(coverage).sort();
  const maxClaims = Math.max(...topics.map(t => coverage[t].claims), 1);

  let html = '';
  topics.forEach(topic => {
    const entry = coverage[topic];
    const widthPct = Math.max((entry.claims / maxClaims) * 100, 8);
    const statusClass = 'status-' + entry.status;
    const bgColor = EVIDENCE_COLORS[entry.max_evidence] || EVIDENCE_COLORS.stated;

    html += '<div class="coverage-bar-row">';
    html += '<span class="coverage-topic" title="' + escapeHtml(topic) + '">' + escapeHtml(topic) + '</span>';
    html += '<div class="coverage-bar-track">';
    html += '<div class="coverage-bar-fill" style="width:' + widthPct + '%;background:' + bgColor + ';opacity:0.7;"></div>';
    html += '</div>';
    html += '<span class="coverage-status ' + statusClass + '">' + entry.status + '</span>';
    html += '</div>';
  });

  coverageContainer.innerHTML = html;
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function renderStats(frame) {
  const prev = currentFrame > 0 ? FRAMES[currentFrame - 1] : null;

  // Animate counters
  animateCounter('statClaims', frame.stats.total, prev?.stats.total);
  animateCounter('statTopics', frame.stats.topics, prev?.stats.topics);
  animateCounter('statConflicts', frame.conflicts.unresolved, prev?.conflicts.unresolved);

  document.getElementById('statPhase').textContent = frame.stats.phase;

  // Evidence distribution
  const evidenceCounts = {};
  EVIDENCE_ORDER.forEach(e => evidenceCounts[e] = 0);
  frame.claims.forEach(c => {
    if (evidenceCounts[c.evidence] !== undefined) evidenceCounts[c.evidence]++;
  });

  const total = frame.claims.length || 1;
  const distEl = document.getElementById('evidenceDist');
  const legendEl = document.getElementById('evidenceLegend');

  let distHtml = '';
  let legendHtml = '';
  EVIDENCE_ORDER.forEach(tier => {
    const count = evidenceCounts[tier];
    if (count > 0) {
      const pct = (count / total) * 100;
      distHtml += '<div class="evidence-dist-seg" style="width:' + pct + '%;background:' + EVIDENCE_COLORS[tier] + '"></div>';
      legendHtml += '<span class="evidence-legend-item"><span class="evidence-legend-dot" style="background:' + EVIDENCE_COLORS[tier] + '"></span>' + tier + ' ' + count + '</span>';
    }
  });

  distEl.innerHTML = distHtml;
  legendEl.innerHTML = legendHtml;
}

function animateCounter(elId, target, prevTarget) {
  const el = document.getElementById(elId);
  const deltaEl = document.getElementById(elId + 'Delta');

  el.textContent = target;

  if (deltaEl && prevTarget !== undefined && prevTarget !== null) {
    const diff = target - prevTarget;
    if (diff > 0) {
      deltaEl.textContent = '+' + diff;
      deltaEl.className = 'stat-delta positive';
    } else if (diff < 0) {
      deltaEl.textContent = '' + diff;
      deltaEl.className = 'stat-delta negative';
    } else {
      deltaEl.textContent = '';
      deltaEl.className = 'stat-delta neutral';
    }
  }
}

// ─── Delta Bar ───────────────────────────────────────────────────────────────
function renderDelta(frame) {
  const delta = frame.delta;
  const parts = [];

  parts.push('<span style="color:var(--text-dim)">Frame ' + (frame.index + 1) + ':</span>');

  if (!delta) {
    parts.push('<span>Initial state</span>');
  } else {
    if (delta.added.length > 0) {
      parts.push('<span class="delta-item"><span class="delta-dot" style="background:var(--green)"></span>+' + delta.added.length + ' claims</span>');
    }
    if (delta.removed.length > 0) {
      parts.push('<span class="delta-item"><span class="delta-dot" style="background:var(--red)"></span>-' + delta.removed.length + ' removed</span>');
    }
    if (delta.upgraded.length > 0) {
      const upgStr = delta.upgraded.map(u => u.topic + ': ' + u.from + ' -> ' + u.to).join(', ');
      parts.push('<span class="delta-item"><span class="delta-dot" style="background:var(--orange)"></span>' + delta.upgraded.length + ' upgraded (' + escapeHtml(upgStr) + ')</span>');
    }
    if (delta.newTopics.length > 0) {
      parts.push('<span class="delta-item"><span class="delta-dot" style="background:var(--purple)"></span>New: ' + escapeHtml(delta.newTopics.join(', ')) + '</span>');
    }
    if (delta.statusChanges.length > 0) {
      parts.push('<span class="delta-item"><span class="delta-dot" style="background:var(--accent)"></span>' + delta.statusChanges.length + ' status change(s)</span>');
    }
  }

  if (frame.milestone) {
    parts.push('<span class="milestone-tag">' + escapeHtml(frame.milestone) + '</span>');
  }

  deltaBar.innerHTML = parts.join(' ');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}
</script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  console.log('build-replay.js: Starting frame extraction...');

  // Ensure output dir
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Step 1: Get commits
  const commits = getCommits();
  console.log(`  Found ${commits.length} commits touching claims.json`);

  if (commits.length === 0) {
    console.error('No commits found. Is this a git repo with claims.json history?');
    process.exit(1);
  }

  // Steps 2-3: Extract and compile
  console.log('  Extracting and compiling snapshots...');
  const { tmpDir, compilations } = extractAndCompile(commits);
  const validCount = compilations.filter(Boolean).length;
  console.log(`  Compiled ${validCount}/${commits.length} snapshots`);

  // Step 4: Compute deltas
  console.log('  Computing deltas...');
  const deltas = computeDeltas(compilations, tmpDir);

  // Step 5: Detect milestones
  console.log('  Detecting milestones...');
  const milestones = detectMilestones(compilations, deltas);
  const milestoneCount = milestones.filter(Boolean).length;
  console.log(`  Found ${milestoneCount} milestone events`);

  // Step 6: Build frames
  const frames = buildFrames(commits, compilations, deltas, milestones);
  console.log(`  Built ${frames.length} frames`);

  // Step 7: Generate HTML
  console.log('  Generating HTML...');
  const html = generateHTML(frames);
  const finalHtml = html.replace('__FRAMES_PLACEHOLDER__', JSON.stringify(frames));
  fs.writeFileSync(OUTPUT_FILE, finalHtml);
  console.log(`  Written to ${OUTPUT_FILE}`);

  // Step 8: Cleanup
  console.log('  Cleaning up temp files...');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\nbuild-replay.js: Done. ${frames.length} frames, ${milestoneCount} milestones.`);
  console.log(`Open output/replay.html in a browser to view the replay.`);
}

main();
