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

// --help / -h
const _replayArgs = process.argv.slice(2);
if (_replayArgs.includes('--help') || _replayArgs.includes('-h')) {
  console.log(`Wheat Replay Builder v0.1.0 — Generate interactive sprint replay from git history

Usage:
  node build-replay.js                Build output/replay.html from git history
  node build-replay.js --dry-run      Show frame count without generating HTML
  node build-replay.js --help         Show this help message

Extracts claims.json at each git commit, compiles snapshots, computes deltas,
detects milestones, and generates a self-contained HTML replay viewer.

Output: output/replay.html`);
  process.exit(0);
}

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
// ─── Step 6: Load HTML template ─────────────────────────────────────────────
// Template extracted to templates/replay.html (contains __FRAMES_PLACEHOLDER__)
function loadReplayTemplate() {
  return fs.readFileSync(path.join(__dirname, 'templates', 'replay.html'), 'utf8');
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

  // --dry-run: report counts and exit without generating HTML
  if (_replayArgs.includes('--dry-run')) {
    // Cleanup temp files
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`\nWould generate ${validCount} frames, ${milestoneCount} milestones`);
    process.exit(0);
  }

  // Step 6: Build frames
  const frames = buildFrames(commits, compilations, deltas, milestones);
  console.log(`  Built ${frames.length} frames`);

  // Step 7: Generate HTML
  console.log('  Generating HTML...');
  const html = loadReplayTemplate();
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
