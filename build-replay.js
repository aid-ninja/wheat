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

// ─── Step 5a: Classify milestone types and generate annotations ─────────────
const ANNOTATION_MAP = {
  'phase-transition': {
    color: '#3b82f6',
    label: 'Phase Transition',
    template: (ms) => {
      const match = ms.match(/Phase:\s*(\w+)\s*->\s*(\w+)/);
      if (match) {
        return `The sprint just moved from <strong>${match[1]}</strong> to <strong>${match[2]}</strong>. In Wheat, each phase adds different types of evidence — define gathers constraints, research finds facts, prototype produces tested evidence, and evaluate weighs trade-offs.`;
      }
      return 'The sprint transitioned to a new phase. Each Wheat phase progressively strengthens the evidence base.';
    },
  },
  'first-conflict': {
    color: '#ef4444',
    label: 'First Conflict',
    template: () => 'A conflict appeared — two claims disagree. Wheat\'s compiler detected this automatically. Use <code>/resolve</code> to pick a winner based on evidence tier.',
  },
  'conflict-new': {
    color: '#ef4444',
    label: 'New Conflict',
    template: () => 'New conflicts emerged between claims. The compiler flags these so nothing ships with contradictory evidence. Run <code>/resolve</code> to adjudicate.',
  },
  'evidence-upgrade': {
    color: '#22c55e',
    label: 'Evidence Upgrade',
    template: (ms) => {
      const upgrades = [...ms.matchAll(/(\w+):\s*(\w+)\s*->\s*(\w+)/g)];
      if (upgrades.length > 0) {
        const parts = upgrades.map(m => `<strong>${m[1]}</strong> from ${m[2]} to ${m[3]}`).join(', ');
        return `Evidence upgraded: ${parts}. A <code>/prototype</code> or <code>/witness</code> proved the claim works in practice, moving it up the evidence ladder.`;
      }
      return 'This topic just got upgraded to stronger evidence. A /prototype proved the claim works in practice.';
    },
  },
  'challenge-disprove': {
    color: '#f472b6',
    label: 'Challenge Result',
    template: () => 'A <code>/challenge</code> found a claim was wrong. It\'s now superseded. This is how Wheat self-corrects — adversarial testing removes weak claims before they reach decisions.',
  },
  'witness-corroboration': {
    color: '#a78bfa',
    label: 'Witness Corroboration',
    template: () => 'External evidence supports this claim. <code>/witness</code> found an independent source that agrees, strengthening the evidence from a single observation to corroborated fact.',
  },
  'compilation-unblocked': {
    color: '#22c55e',
    label: 'Compiler Unblocked',
    template: () => 'The compiler was blocked by conflicts. After <code>/resolve</code>, it\'s ready again — all claims are consistent and output artifacts can be produced.',
  },
  'compilation-blocked': {
    color: '#ef4444',
    label: 'Compiler Blocked',
    template: () => 'The compiler just became <strong>blocked</strong>. Unresolved conflicts prevent output artifacts from being generated. Run <code>/resolve</code> to clear the blockage.',
  },
  'sprint-begins': {
    color: '#3b82f6',
    label: 'Sprint Start',
    template: () => 'The sprint begins. Wheat tracks every claim, its evidence tier, and relationships to other claims. Watch how the knowledge base grows commit by commit.',
  },
  'new-topics': {
    color: '#a78bfa',
    label: 'New Topics',
    template: (ms) => {
      const match = ms.match(/New topic\(s\):\s*(.+?)(\s*\||$)/);
      if (match) {
        return `New research area(s) discovered: <strong>${match[1]}</strong>. Wheat\'s coverage map now tracks evidence depth for each topic independently.`;
      }
      return 'New topics entered the sprint. The coverage map expands as research uncovers new areas to investigate.';
    },
  },
  'batch-claims': {
    color: '#a78bfa',
    label: 'Batch Addition',
    template: (ms) => {
      const match = ms.match(/\+(\d+) claims added/);
      if (match) {
        return `A large batch of <strong>${match[1]} claims</strong> was added in one commit. This typically happens during a deep <code>/research</code> pass or a speedrun session.`;
      }
      return 'A batch of claims was added. Wheat replays batch commits as sub-frames so you can see each claim arrive.';
    },
  },
  'conflicts-resolved': {
    color: '#22c55e',
    label: 'Conflicts Resolved',
    template: () => 'Conflicts were resolved. The winning claim keeps its evidence tier; the loser is superseded but preserved in the audit trail.',
  },
};

function classifyMilestone(milestoneStr, frameIndex, allMilestones) {
  if (!milestoneStr) return null;

  const types = [];

  // Sprint begins
  if (milestoneStr.includes('Sprint begins')) {
    types.push('sprint-begins');
  }

  // Phase transition
  if (/Phase:\s*\w+\s*->\s*\w+/.test(milestoneStr)) {
    types.push('phase-transition');
  }

  // Evidence upgrades
  if (/\w+:\s*(stated|web|documented|tested|production)\s*->\s*(stated|web|documented|tested|production)/.test(milestoneStr)) {
    types.push('evidence-upgrade');
  }

  // Conflicts — check if this is the first conflict ever
  if (/\d+ new conflict\(s\)/.test(milestoneStr)) {
    const priorHasConflict = allMilestones.slice(0, frameIndex).some(
      m => m && /\d+ new conflict\(s\)/.test(m)
    );
    types.push(priorHasConflict ? 'conflict-new' : 'first-conflict');
  }

  // Conflicts resolved
  if (/\d+ conflict\(s\) resolved/.test(milestoneStr)) {
    types.push('conflicts-resolved');
  }

  // Status changes
  if (/Status:\s*blocked\s*->\s*ready/.test(milestoneStr)) {
    types.push('compilation-unblocked');
  }
  if (/Status:\s*ready\s*->\s*blocked/.test(milestoneStr)) {
    types.push('compilation-blocked');
  }

  // New topics
  if (/New topic\(s\):/.test(milestoneStr)) {
    types.push('new-topics');
  }

  // Batch claims
  if (/\+\d+ claims added/.test(milestoneStr)) {
    types.push('batch-claims');
  }

  // Pick the most interesting type (priority order)
  const PRIORITY = [
    'first-conflict', 'compilation-unblocked', 'compilation-blocked',
    'challenge-disprove', 'phase-transition', 'evidence-upgrade',
    'witness-corroboration', 'conflicts-resolved', 'conflict-new',
    'sprint-begins', 'new-topics', 'batch-claims',
  ];

  const primary = PRIORITY.find(t => types.includes(t)) || types[0];
  if (!primary) return null;

  const annotation = ANNOTATION_MAP[primary];
  return {
    type: primary,
    label: annotation.label,
    color: annotation.color,
    text: annotation.template(milestoneStr),
    allTypes: types,
  };
}

// ─── Step 5b: Detect batch commits ──────────────────────────────────────────
const BATCH_THRESHOLD = 3; // commits adding more than this many claims are "batch"

function isBatchCommit(delta) {
  if (!delta) return false;
  return (delta.new_claims || []).length > BATCH_THRESHOLD;
}

// ─── Step 6: Build FRAMES array (with hybrid sub-framing) ───────────────────
function buildFrames(commits, compilations, deltas, milestones) {
  // Pre-classify all milestones so first-conflict detection works
  const classifiedMilestones = milestones.map((ms, i) => classifyMilestone(ms, i, milestones));
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
          annotation: s === 0 ? classifiedMilestones[i] : null,
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
        annotation: classifiedMilestones[i],
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

  /* ─── Sandbox panel ──────────────────────────────────────────────── */
  .sandbox-toggle {
    background: rgba(245,158,11,0.12);
    border: 1px solid rgba(245,158,11,0.3);
    color: var(--orange);
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 9pt;
    font-family: inherit;
    font-weight: 600;
    letter-spacing: 0.03em;
    transition: background 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }

  .sandbox-toggle:hover {
    background: rgba(245,158,11,0.2);
    border-color: rgba(245,158,11,0.5);
  }

  .sandbox-toggle.active {
    background: var(--orange);
    color: var(--bg-dark);
    border-color: var(--orange);
  }

  .sandbox-panel {
    display: none;
    padding: 14px 24px;
    background: linear-gradient(180deg, rgba(30,41,59,1) 0%, rgba(15,23,42,1) 100%);
    border-top: 2px solid var(--orange);
    flex-shrink: 0;
    animation: sandboxSlideIn 0.25s ease-out;
  }

  .sandbox-panel.visible {
    display: block;
  }

  @keyframes sandboxSlideIn {
    from { opacity: 0; max-height: 0; }
    to { opacity: 1; max-height: 300px; }
  }

  .sandbox-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .sandbox-title {
    font-size: 9pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--orange);
  }

  .sandbox-count {
    font-size: 8pt;
    color: var(--text-dim);
    margin-left: 8px;
  }

  .sandbox-actions {
    display: flex;
    gap: 8px;
  }

  .sandbox-reset {
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.3);
    color: var(--red);
    border-radius: 4px;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 8pt;
    font-family: inherit;
    transition: background 0.15s;
  }

  .sandbox-reset:hover {
    background: rgba(239,68,68,0.2);
  }

  .sandbox-form {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    flex-wrap: wrap;
  }

  .sandbox-field {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .sandbox-field label {
    font-size: 7.5pt;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
  }

  .sandbox-field select,
  .sandbox-field input[type="text"] {
    background: var(--bg-card);
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text);
    border-radius: 4px;
    padding: 5px 8px;
    font-size: 9pt;
    font-family: inherit;
    outline: none;
    transition: border-color 0.15s;
  }

  .sandbox-field select:focus,
  .sandbox-field input[type="text"]:focus {
    border-color: var(--orange);
  }

  .sandbox-field input[type="text"] {
    min-width: 260px;
  }

  .sandbox-add-btn {
    background: var(--orange);
    border: none;
    color: var(--bg-dark);
    border-radius: 4px;
    padding: 5px 14px;
    cursor: pointer;
    font-size: 9pt;
    font-family: inherit;
    font-weight: 600;
    transition: opacity 0.15s;
  }

  .sandbox-add-btn:hover {
    opacity: 0.85;
  }

  .sandbox-add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Sandbox badge on claims */
  .sandbox-badge {
    font-size: 6.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: rgba(245,158,11,0.15);
    color: var(--orange);
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
    margin-left: 4px;
  }

  /* Sandbox tooltip */
  .sandbox-tooltip {
    display: none;
    margin-top: 10px;
    padding: 10px 14px;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.2);
    border-radius: 6px;
    font-size: 8.5pt;
    color: var(--text-muted);
    line-height: 1.5;
    animation: sandboxSlideIn 0.25s ease-out;
  }

  .sandbox-tooltip.visible {
    display: block;
  }

  .sandbox-tooltip strong {
    color: var(--orange);
  }

  .sandbox-tooltip code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 8pt;
    background: rgba(255,255,255,0.06);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--accent-light);
  }

  /* Sandbox compiler warning */
  .sandbox-warning {
    display: none;
    margin-top: 8px;
    padding: 8px 12px;
    background: rgba(239,68,68,0.08);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: 6px;
    font-size: 8.5pt;
    color: var(--red);
    line-height: 1.5;
    animation: sandboxSlideIn 0.25s ease-out;
  }

  .sandbox-warning.visible {
    display: block;
  }

  /* ─── Annotation panel ──────────────────────────────────────────────── */
  .annotation-panel {
    padding: 12px 24px 12px 20px;
    background: var(--bg-card);
    border-top: 1px solid rgba(255,255,255,0.06);
    flex-shrink: 0;
    display: none;
    align-items: flex-start;
    gap: 12px;
    animation: annotationSlideIn 0.3s ease-out;
    position: relative;
  }

  .annotation-panel.visible {
    display: flex;
  }

  @keyframes annotationSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .annotation-accent {
    width: 4px;
    border-radius: 2px;
    align-self: stretch;
    flex-shrink: 0;
  }

  .annotation-body {
    flex: 1;
    min-width: 0;
  }

  .annotation-label {
    font-size: 8pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 4px;
  }

  .annotation-text {
    font-size: 9.5pt;
    color: var(--text-muted);
    line-height: 1.5;
  }

  .annotation-text strong {
    color: var(--text);
    font-weight: 600;
  }

  .annotation-text code {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 8.5pt;
    background: rgba(255,255,255,0.06);
    padding: 1px 5px;
    border-radius: 3px;
    color: var(--accent-light);
  }

  .annotation-dismiss {
    background: none;
    border: 1px solid rgba(255,255,255,0.1);
    color: var(--text-dim);
    cursor: pointer;
    font-size: 10pt;
    padding: 2px 8px;
    border-radius: 4px;
    flex-shrink: 0;
    line-height: 1;
    transition: color 0.15s, border-color 0.15s;
  }

  .annotation-dismiss:hover {
    color: var(--text);
    border-color: rgba(255,255,255,0.25);
  }

  .annotation-pause-hint {
    font-size: 7.5pt;
    color: var(--text-dim);
    margin-top: 4px;
    font-style: italic;
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
      <button class="sandbox-toggle" id="sandboxToggle" title="Toggle Sandbox (S)">Try it</button>
    </div>
  </div>
  <div class="commit-msg" id="commitMsg">—</div>
</div>

<!-- Sandbox panel -->
<div class="sandbox-panel" id="sandboxPanel">
  <div class="sandbox-header">
    <div>
      <span class="sandbox-title">Sandbox</span>
      <span class="sandbox-count" id="sandboxCount"></span>
    </div>
    <div class="sandbox-actions">
      <button class="sandbox-reset" id="sandboxReset" title="Clear all sandbox claims">Reset</button>
    </div>
  </div>
  <div class="sandbox-form">
    <div class="sandbox-field">
      <label>Type</label>
      <select id="sandboxType">
        <option value="factual">factual</option>
        <option value="constraint">constraint</option>
        <option value="estimate">estimate</option>
        <option value="risk">risk</option>
        <option value="recommendation">recommendation</option>
        <option value="feedback">feedback</option>
      </select>
    </div>
    <div class="sandbox-field">
      <label>Topic</label>
      <select id="sandboxTopic"></select>
    </div>
    <div class="sandbox-field">
      <label>Evidence</label>
      <select id="sandboxEvidence">
        <option value="stated">stated</option>
        <option value="web" selected>web</option>
        <option value="documented">documented</option>
        <option value="tested">tested</option>
        <option value="production">production</option>
      </select>
    </div>
    <div class="sandbox-field" style="flex:1;">
      <label>Content</label>
      <input type="text" id="sandboxContent" placeholder="Write a mock claim..." />
    </div>
    <button class="sandbox-add-btn" id="sandboxAdd">Add Claim</button>
  </div>
  <div class="sandbox-tooltip" id="sandboxTooltip"></div>
  <div class="sandbox-warning" id="sandboxWarning"></div>
</div>

<!-- Annotation panel (shown on milestone frames) -->
<div class="annotation-panel" id="annotationPanel">
  <div class="annotation-accent" id="annotationAccent"></div>
  <div class="annotation-body">
    <div class="annotation-label" id="annotationLabel"></div>
    <div class="annotation-text" id="annotationText"></div>
    <div class="annotation-pause-hint" id="annotationPauseHint"></div>
  </div>
  <button class="annotation-dismiss" id="annotationDismiss" title="Dismiss (Esc)">&#10005;</button>
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
  <kbd>S</kbd> sandbox &nbsp;
  <kbd>Esc</kbd> dismiss &nbsp;
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
let annotationDismissed = false; // tracks if user dismissed current annotation
let milestonePauseTimer = null;  // timer for auto-pause on milestones
const MILESTONE_PAUSE_MS = 3000; // auto-pause duration on milestone frames

// ─── Sandbox state ────────────────────────────────────────────────────────
let sandboxOpen = false;
let sandboxClaims = []; // { id, type, topic, content, evidence, status }
let sandboxCounter = 0;
let sandboxFirstClaim = true; // track if first claim for educational tooltip

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
const annotationPanel = document.getElementById('annotationPanel');
const annotationAccent = document.getElementById('annotationAccent');
const annotationLabel = document.getElementById('annotationLabel');
const annotationText = document.getElementById('annotationText');
const annotationDismissBtn = document.getElementById('annotationDismiss');
const annotationPauseHint = document.getElementById('annotationPauseHint');

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
  const frameDenom = Math.max(FRAMES.length - 1, 1);
  FRAMES.forEach((f, i) => {
    if (f.milestone) {
      const pct = (i / frameDenom) * 100;
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
      const startPct = (batchStart / frameDenom) * 100;
      const endPct = (end / frameDenom) * 100;
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
  annotationDismissed = false; // reset on scrub
  if (milestonePauseTimer) {
    clearTimeout(milestonePauseTimer);
    milestonePauseTimer = null;
  }
  render(FRAMES[currentFrame]);
});

playBtn.addEventListener('click', togglePlay);

nextCommitBtn.addEventListener('click', goToNextCommit);

annotationDismissBtn.addEventListener('click', () => {
  annotationDismissed = true;
  annotationPanel.classList.remove('visible');
  // If paused at milestone, clear the pause timer and resume
  if (milestonePauseTimer) {
    clearTimeout(milestonePauseTimer);
    milestonePauseTimer = null;
    if (!playing) resumeFromMilestonePause();
  }
});

function resumeFromMilestonePause() {
  // Resume playback after milestone pause (only if we were playing before)
  if (annotationPanel._wasPlaying) {
    annotationPanel._wasPlaying = false;
    togglePlay();
  }
}

// ─── Sandbox controls ─────────────────────────────────────────────────────
const sandboxToggle = document.getElementById('sandboxToggle');
const sandboxPanel = document.getElementById('sandboxPanel');
const sandboxCount = document.getElementById('sandboxCount');
const sandboxTopicSelect = document.getElementById('sandboxTopic');
const sandboxTypeSelect = document.getElementById('sandboxType');
const sandboxEvidenceSelect = document.getElementById('sandboxEvidence');
const sandboxContentInput = document.getElementById('sandboxContent');
const sandboxAddBtn = document.getElementById('sandboxAdd');
const sandboxResetBtn = document.getElementById('sandboxReset');
const sandboxTooltip = document.getElementById('sandboxTooltip');
const sandboxWarning = document.getElementById('sandboxWarning');

function toggleSandbox() {
  sandboxOpen = !sandboxOpen;
  sandboxPanel.classList.toggle('visible', sandboxOpen);
  sandboxToggle.classList.toggle('active', sandboxOpen);
  if (sandboxOpen) populateSandboxTopics();
}

function populateSandboxTopics() {
  // Gather unique topics from current frame
  const frame = FRAMES[currentFrame];
  if (!frame) return;
  const topics = new Set();
  frame.claims.forEach(c => topics.add(c.topic));
  sandboxClaims.forEach(c => topics.add(c.topic));
  const sorted = [...topics].sort();

  const current = sandboxTopicSelect.value;
  sandboxTopicSelect.innerHTML = '';
  sorted.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    sandboxTopicSelect.appendChild(opt);
  });
  if (current && sorted.includes(current)) {
    sandboxTopicSelect.value = current;
  }
}

function addSandboxClaim() {
  const type = sandboxTypeSelect.value;
  const topic = sandboxTopicSelect.value;
  const evidence = sandboxEvidenceSelect.value;
  const content = sandboxContentInput.value.trim();
  if (!content || !topic) return;

  sandboxCounter++;
  const claim = {
    id: 'sb' + String(sandboxCounter).padStart(3, '0'),
    type,
    topic,
    content,
    evidence,
    status: 'active',
    sandbox: true,
  };
  sandboxClaims.push(claim);
  sandboxContentInput.value = '';
  sandboxCount.textContent = sandboxClaims.length + ' sandbox claim' + (sandboxClaims.length !== 1 ? 's' : '');

  // Educational tooltip on first claim
  if (sandboxFirstClaim) {
    sandboxFirstClaim = false;
    const tipType = type;
    const tipEvidence = evidence;
    sandboxTooltip.innerHTML =
      'You just created a <strong>' + escapeHtml(tipType) + '</strong> claim at ' +
      '<strong>' + escapeHtml(tipEvidence) + '</strong>-level evidence. ' +
      'Try adding a <code>/prototype</code> to upgrade it to <strong>tested</strong>. ' +
      'In Wheat, evidence tiers determine how much weight the compiler gives each claim.';
    sandboxTooltip.classList.add('visible');
    setTimeout(() => sandboxTooltip.classList.remove('visible'), 12000);
  }

  // Check for conflicts: same topic, contradictory type or opposing recommendations
  checkSandboxConflicts(claim);

  // Re-render with sandbox claims overlaid
  render(FRAMES[currentFrame]);
}

function checkSandboxConflicts(newClaim) {
  const frame = FRAMES[currentFrame];
  if (!frame) return;

  // Find existing claims on same topic with different type
  const sameTopic = frame.claims.filter(c => c.topic === newClaim.topic);
  const hasConflict = sameTopic.some(c => {
    // Simple conflict heuristic: a risk vs recommendation on same topic
    return (c.type === 'risk' && newClaim.type === 'recommendation') ||
           (c.type === 'recommendation' && newClaim.type === 'risk') ||
           (c.type === 'constraint' && newClaim.type === 'recommendation');
  });

  // Also check sandbox-to-sandbox conflicts
  const sameTopicSandbox = sandboxClaims.filter(c => c.topic === newClaim.topic && c.id !== newClaim.id);
  const hasSandboxConflict = sameTopicSandbox.some(c => {
    return (c.type === 'risk' && newClaim.type === 'recommendation') ||
           (c.type === 'recommendation' && newClaim.type === 'risk') ||
           (c.type === 'constraint' && newClaim.type === 'recommendation');
  });

  if (hasConflict || hasSandboxConflict) {
    const conflictWith = hasConflict
      ? sameTopic.find(c => (c.type === 'risk' && newClaim.type === 'recommendation') || (c.type === 'recommendation' && newClaim.type === 'risk') || (c.type === 'constraint' && newClaim.type === 'recommendation'))
      : sameTopicSandbox.find(c => (c.type === 'risk' && newClaim.type === 'recommendation') || (c.type === 'recommendation' && newClaim.type === 'risk') || (c.type === 'constraint' && newClaim.type === 'recommendation'));

    sandboxWarning.innerHTML =
      '<strong>Compiler warning:</strong> Potential conflict detected between ' +
      '<strong>' + escapeHtml(newClaim.id) + '</strong> (' + escapeHtml(newClaim.type) + ') and ' +
      '<strong>' + escapeHtml(conflictWith.id) + '</strong> (' + escapeHtml(conflictWith.type) + ') on topic "' +
      escapeHtml(newClaim.topic) + '". In a real sprint, <code>/resolve</code> would adjudicate based on evidence tier.';
    sandboxWarning.classList.add('visible');
    setTimeout(() => sandboxWarning.classList.remove('visible'), 15000);
  }
}

function resetSandbox() {
  sandboxClaims = [];
  sandboxCounter = 0;
  sandboxFirstClaim = true;
  sandboxCount.textContent = '';
  sandboxTooltip.classList.remove('visible');
  sandboxWarning.classList.remove('visible');
  render(FRAMES[currentFrame]);
}

sandboxToggle.addEventListener('click', toggleSandbox);
sandboxAddBtn.addEventListener('click', addSandboxClaim);
sandboxResetBtn.addEventListener('click', resetSandbox);
sandboxContentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSandboxClaim(); }
  e.stopPropagation(); // prevent keyboard shortcuts while typing
});
// Prevent keyboard nav when focused on sandbox inputs
sandboxContentInput.addEventListener('keyup', (e) => e.stopPropagation());

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
  if (e.target.tagName === 'SELECT') return;

  switch(e.key) {
    case 's':
    case 'S':
      e.preventDefault();
      toggleSandbox();
      break;
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
    case 'Escape':
      e.preventDefault();
      if (annotationPanel.classList.contains('visible')) {
        annotationDismissed = true;
        annotationPanel.classList.remove('visible');
        if (milestonePauseTimer) {
          clearTimeout(milestonePauseTimer);
          milestonePauseTimer = null;
          resumeFromMilestonePause();
        }
      }
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
  annotationDismissed = false; // reset on frame change
  if (milestonePauseTimer) {
    clearTimeout(milestonePauseTimer);
    milestonePauseTimer = null;
  }
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

      const frame = FRAMES[currentFrame];
      // Reset dismissed state for new milestone frames
      annotationDismissed = false;
      render(frame);

      // Auto-pause on milestone frames with annotations
      if (frame.annotation) {
        annotationPanel._wasPlaying = true;
        togglePlay(); // pause
        annotationPauseHint.textContent = 'Auto-resuming in a moment... Click \\u2715 or press Esc to dismiss.';
        milestonePauseTimer = setTimeout(() => {
          milestonePauseTimer = null;
          annotationPauseHint.textContent = '';
          if (!playing && annotationPanel._wasPlaying) {
            annotationPanel._wasPlaying = false;
            togglePlay(); // resume
          }
        }, MILESTONE_PAUSE_MS);
        return;
      }
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

  // Annotation panel
  renderAnnotation(frame);

  // Update sandbox topic dropdown if sandbox is open
  if (sandboxOpen) populateSandboxTopics();
}

// ─── Claims Panel ────────────────────────────────────────────────────────────
function renderClaims(frame) {
  // Merge frame claims + sandbox claims
  const allClaims = [...frame.claims];
  sandboxClaims.forEach(sc => allClaims.push(sc));

  const groups = {};
  allClaims.forEach(c => {
    if (!groups[c.topic]) groups[c.topic] = [];
    groups[c.topic].push(c);
  });

  const addedSet = new Set(frame.delta?.added || []);
  const removedSet = new Set(frame.delta?.removed || []);

  let html = '';
  const sortedTopics = Object.keys(groups).sort();

  sortedTopics.forEach(topic => {
    const claims = groups[topic];
    const sandboxInTopic = claims.filter(c => c.sandbox);
    const totalLabel = sandboxInTopic.length > 0
      ? claims.length + ' <span style="color:var(--orange);font-size:7pt;">(+' + sandboxInTopic.length + ' sandbox)</span>'
      : '' + claims.length;
    html += '<div class="topic-group">';
    html += '<div class="topic-header"><span>' + escapeHtml(topic) + '</span><span class="topic-count">' + totalLabel + '</span></div>';

    claims.forEach((c, idx) => {
      const isNew = addedSet.has(c.id);
      const isSandbox = c.sandbox;
      const classes = ['claim-item'];
      if (isNew) {
        classes.push('badge-new', 'claim-enter');
      }
      if (isSandbox) {
        classes.push('claim-enter');
      }

      const maxStagger = Math.max((1000 / speed) * 0.4, 100);
      const staggerMs = Math.min(idx * 20, maxStagger);
      const delay = (isNew || isSandbox) ? ' style="animation-delay:' + staggerMs + 'ms"' : '';

      html += '<div class="' + classes.join(' ') + '"' + delay + '>';
      html += '<span class="claim-id">' + c.id + '</span>';
      html += '<span class="claim-content">' + escapeHtml(truncate(c.content, 80)) + '</span>';
      html += '<span class="claim-evidence evidence-' + c.evidence + '">' + c.evidence + '</span>';
      if (isSandbox) {
        html += '<span class="sandbox-badge">sandbox</span>';
      }
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
  // Build coverage including sandbox claims
  const coverage = {};
  // Start from frame coverage
  Object.keys(frame.coverage).forEach(topic => {
    coverage[topic] = { ...frame.coverage[topic], sandboxExtra: 0 };
  });
  // Overlay sandbox claims
  sandboxClaims.forEach(sc => {
    if (!coverage[sc.topic]) {
      coverage[sc.topic] = { claims: 0, max_evidence: sc.evidence, status: 'weak', sandboxExtra: 0 };
    }
    coverage[sc.topic].claims++;
    coverage[sc.topic].sandboxExtra++;
    // Check if sandbox claim upgrades evidence
    const tiers = ['stated', 'web', 'documented', 'tested', 'production'];
    const curIdx = tiers.indexOf(coverage[sc.topic].max_evidence);
    const newIdx = tiers.indexOf(sc.evidence);
    if (newIdx > curIdx) coverage[sc.topic].max_evidence = sc.evidence;
  });

  const topics = Object.keys(coverage).sort();
  const maxClaims = Math.max(...topics.map(t => coverage[t].claims), 1);

  let html = '';
  topics.forEach(topic => {
    const entry = coverage[topic];
    const widthPct = Math.max((entry.claims / maxClaims) * 100, 8);
    const statusClass = 'status-' + entry.status;
    const bgColor = EVIDENCE_COLORS[entry.max_evidence] || EVIDENCE_COLORS.stated;
    const hasSandbox = entry.sandboxExtra > 0;

    html += '<div class="coverage-bar-row">';
    html += '<span class="coverage-topic" title="' + escapeHtml(topic) + '">' + escapeHtml(topic);
    if (hasSandbox) html += ' <span style="color:var(--orange);font-size:7pt;">+' + entry.sandboxExtra + '</span>';
    html += '</span>';
    html += '<div class="coverage-bar-track">';
    html += '<div class="coverage-bar-fill" style="width:' + widthPct + '%;background:' + bgColor + ';opacity:0.7;' + (hasSandbox ? 'box-shadow:0 0 6px rgba(245,158,11,0.4);' : '') + '"></div>';
    html += '</div>';
    html += '<span class="coverage-status ' + statusClass + '">' + entry.status + '</span>';
    html += '</div>';
  });

  coverageContainer.innerHTML = html;
}

// ─── Stats ───────────────────────────────────────────────────────────────────
function renderStats(frame) {
  const prev = currentFrame > 0 ? FRAMES[currentFrame - 1] : null;

  // Include sandbox claims in counts
  const sandboxTotal = sandboxClaims.length;
  const sandboxTopics = new Set(sandboxClaims.map(c => c.topic));
  const frameTopics = new Set(Object.keys(frame.coverage));
  const newSandboxTopics = [...sandboxTopics].filter(t => !frameTopics.has(t)).length;

  // Animate counters
  animateCounter('statClaims', frame.stats.total + sandboxTotal, prev?.stats.total);
  animateCounter('statTopics', frame.stats.topics + newSandboxTopics, prev?.stats.topics);
  animateCounter('statConflicts', frame.conflicts.unresolved, prev?.conflicts.unresolved);

  document.getElementById('statPhase').textContent = frame.stats.phase;

  // Evidence distribution (include sandbox)
  const evidenceCounts = {};
  EVIDENCE_ORDER.forEach(e => evidenceCounts[e] = 0);
  frame.claims.forEach(c => {
    if (evidenceCounts[c.evidence] !== undefined) evidenceCounts[c.evidence]++;
  });
  sandboxClaims.forEach(c => {
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
  } else if (delta.added.length === 0 && delta.removed.length === 0 && delta.upgraded.length === 0 && delta.newTopics.length === 0 && delta.statusChanges.length === 0) {
    parts.push('<span style="color:var(--text-dim)">Metadata update</span>');
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

// ─── Annotation Panel ────────────────────────────────────────────────────────
function renderAnnotation(frame) {
  if (!frame.annotation || annotationDismissed) {
    annotationPanel.classList.remove('visible');
    return;
  }

  const ann = frame.annotation;
  annotationAccent.style.background = ann.color;
  annotationLabel.style.color = ann.color;
  annotationLabel.textContent = ann.label;
  annotationText.innerHTML = ann.text;

  if (milestonePauseTimer) {
    annotationPauseHint.textContent = 'Auto-resuming in a moment... Click \\u2715 or press Esc to dismiss.';
  } else {
    annotationPauseHint.textContent = '';
  }

  annotationPanel.classList.add('visible');
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
