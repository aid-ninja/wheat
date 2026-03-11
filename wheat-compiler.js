#!/usr/bin/env node
/**
 * Wheat Compiler — Bran-based compilation passes for research claims
 *
 * Reads claims.json, runs validation/conflict/resolution passes,
 * outputs compilation.json that all output artifacts consume.
 *
 * Usage:
 *   node wheat-compiler.js              # compile and write compilation.json
 *   node wheat-compiler.js --check      # compile and exit with error code if blocked
 *   node wheat-compiler.js --summary    # print human-readable summary to stdout
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ─── Evidence tier hierarchy (higher = stronger) ─────────────────────────────
const EVIDENCE_TIERS = {
  stated:     1,
  web:        2,
  documented: 3,
  tested:     4,
  production: 5,
};

const VALID_TYPES = ['constraint', 'factual', 'estimate', 'risk', 'recommendation', 'feedback'];
const VALID_STATUSES = ['active', 'superseded', 'conflicted', 'resolved'];
const VALID_PHASES = ['define', 'research', 'prototype', 'evaluate', 'feedback'];
const PHASE_ORDER = ['init', 'define', 'research', 'prototype', 'evaluate', 'compile'];

// ─── Pass 1: Schema Validation ───────────────────────────────────────────────
function validateSchema(claims) {
  const errors = [];
  const requiredFields = ['id', 'type', 'topic', 'content', 'source', 'evidence', 'status'];

  claims.forEach((claim, i) => {
    requiredFields.forEach(field => {
      if (claim[field] === undefined || claim[field] === null || claim[field] === '') {
        errors.push({
          code: 'E_SCHEMA',
          message: `Claim ${claim.id || `[index ${i}]`} missing required field: ${field}`,
          claims: [claim.id || `index:${i}`],
        });
      }
    });

    // Check for duplicate IDs
    const dupes = claims.filter(c => c.id === claim.id);
    if (dupes.length > 1 && claims.indexOf(claim) === i) {
      errors.push({
        code: 'E_DUPLICATE_ID',
        message: `Duplicate claim ID: ${claim.id}`,
        claims: [claim.id],
      });
    }
  });

  return errors;
}

// ─── Pass 2: Type Checking ───────────────────────────────────────────────────
function validateTypes(claims) {
  const errors = [];

  claims.forEach(claim => {
    if (!VALID_TYPES.includes(claim.type)) {
      errors.push({
        code: 'E_TYPE',
        message: `Claim ${claim.id}: invalid type "${claim.type}". Must be one of: ${VALID_TYPES.join(', ')}`,
        claims: [claim.id],
      });
    }

    if (!Object.keys(EVIDENCE_TIERS).includes(claim.evidence)) {
      errors.push({
        code: 'E_EVIDENCE_TIER',
        message: `Claim ${claim.id}: invalid evidence tier "${claim.evidence}". Must be one of: ${Object.keys(EVIDENCE_TIERS).join(', ')}`,
        claims: [claim.id],
      });
    }

    if (!VALID_STATUSES.includes(claim.status)) {
      errors.push({
        code: 'E_STATUS',
        message: `Claim ${claim.id}: invalid status "${claim.status}". Must be one of: ${VALID_STATUSES.join(', ')}`,
        claims: [claim.id],
      });
    }
  });

  return errors;
}

// ─── Pass 3: Evidence Tier Sorting ───────────────────────────────────────────
function sortByEvidenceTier(claims) {
  return [...claims].sort((a, b) => {
    const tierDiff = (EVIDENCE_TIERS[b.evidence] || 0) - (EVIDENCE_TIERS[a.evidence] || 0);
    if (tierDiff !== 0) return tierDiff;
    // Within same tier, sort by timestamp (newer first)
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });
}

// ─── Pass 4: Conflict Detection ──────────────────────────────────────────────
function detectConflicts(claims) {
  const conflicts = [];
  const activeClaims = claims.filter(c => c.status === 'active' || c.status === 'conflicted');

  for (let i = 0; i < activeClaims.length; i++) {
    for (let j = i + 1; j < activeClaims.length; j++) {
      const a = activeClaims[i];
      const b = activeClaims[j];

      // Same topic + explicitly marked as conflicting
      if (a.conflicts_with && a.conflicts_with.includes(b.id)) {
        conflicts.push({ claimA: a.id, claimB: b.id, topic: a.topic });
      } else if (b.conflicts_with && b.conflicts_with.includes(a.id)) {
        conflicts.push({ claimA: a.id, claimB: b.id, topic: a.topic });
      }
    }
  }

  return conflicts;
}

// ─── Pass 5: Auto-Resolution ─────────────────────────────────────────────────
function autoResolve(claims, conflicts) {
  const resolved = [];
  const unresolved = [];

  conflicts.forEach(conflict => {
    const claimA = claims.find(c => c.id === conflict.claimA);
    const claimB = claims.find(c => c.id === conflict.claimB);

    if (!claimA || !claimB) {
      unresolved.push({ ...conflict, reason: 'claim_not_found' });
      return;
    }

    const tierA = EVIDENCE_TIERS[claimA.evidence] || 0;
    const tierB = EVIDENCE_TIERS[claimB.evidence] || 0;

    if (tierA > tierB) {
      resolved.push({
        winner: claimA.id,
        loser: claimB.id,
        reason: `evidence_tier: ${claimA.evidence} (${tierA}) > ${claimB.evidence} (${tierB})`,
      });
      claimB.status = 'superseded';
      claimB.resolved_by = claimA.id;
    } else if (tierB > tierA) {
      resolved.push({
        winner: claimB.id,
        loser: claimA.id,
        reason: `evidence_tier: ${claimB.evidence} (${tierB}) > ${claimA.evidence} (${tierA})`,
      });
      claimA.status = 'superseded';
      claimA.resolved_by = claimB.id;
    } else {
      // Same evidence tier — cannot auto-resolve
      unresolved.push({
        claimA: claimA.id,
        claimB: claimB.id,
        topic: conflict.topic,
        reason: `same_evidence_tier: both ${claimA.evidence}`,
      });
      claimA.status = 'conflicted';
      claimB.status = 'conflicted';
    }
  });

  return { resolved, unresolved };
}

// ─── Pass 6: Coverage Analysis ───────────────────────────────────────────────
function analyzeCoverage(claims) {
  const coverage = {};
  const activeClaims = claims.filter(c => c.status === 'active' || c.status === 'resolved');

  activeClaims.forEach(claim => {
    if (!claim.topic) return;

    if (!coverage[claim.topic]) {
      coverage[claim.topic] = {
        claims: 0,
        max_evidence: 'stated',
        max_evidence_rank: 0,
        types: new Set(),
        claim_ids: [],
      };
    }

    const entry = coverage[claim.topic];
    entry.claims++;
    entry.types.add(claim.type);
    entry.claim_ids.push(claim.id);

    const tier = EVIDENCE_TIERS[claim.evidence] || 0;
    if (tier > entry.max_evidence_rank) {
      entry.max_evidence = claim.evidence;
      entry.max_evidence_rank = tier;
    }
  });

  // Convert sets to arrays and compute status
  const result = {};
  Object.entries(coverage).forEach(([topic, entry]) => {
    let status = 'weak';
    if (entry.max_evidence_rank >= EVIDENCE_TIERS.tested) status = 'strong';
    else if (entry.max_evidence_rank >= EVIDENCE_TIERS.documented) status = 'moderate';

    result[topic] = {
      claims: entry.claims,
      max_evidence: entry.max_evidence,
      status,
      types: [...entry.types],
      claim_ids: entry.claim_ids,
    };
  });

  return result;
}

// ─── Pass 7: Readiness Check ─────────────────────────────────────────────────
function checkReadiness(errors, unresolvedConflicts, coverage) {
  const blockers = [...errors];

  // Unresolved conflicts are blockers
  unresolvedConflicts.forEach(conflict => {
    blockers.push({
      code: 'E_CONFLICT',
      message: `Unresolved conflict between ${conflict.claimA} and ${conflict.claimB} (topic: ${conflict.topic}) — ${conflict.reason}`,
      claims: [conflict.claimA, conflict.claimB],
    });
  });

  // Weak coverage is a warning, not a blocker
  const warnings = [];
  Object.entries(coverage).forEach(([topic, entry]) => {
    if (entry.status === 'weak') {
      warnings.push({
        code: 'W_WEAK_EVIDENCE',
        message: `Topic "${topic}" has only ${entry.max_evidence}-level evidence (${entry.claims} claims)`,
        claims: entry.claim_ids,
      });
    }
  });

  return { blockers, warnings };
}

// ─── Phase Summary ───────────────────────────────────────────────────────────
function summarizePhases(claims) {
  const summary = {};
  VALID_PHASES.forEach(phase => {
    const phaseClaims = claims.filter(c => c.phase_added === phase);
    summary[phase] = {
      claims: phaseClaims.length,
      complete: phaseClaims.length > 0,
    };
  });
  return summary;
}

// ─── Compilation Certificate ─────────────────────────────────────────────────
function generateCertificate(claimsData, compilerVersion) {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(claimsData))
    .digest('hex');

  return {
    input_hash: `sha256:${hash}`,
    compiler_version: compilerVersion,
    deterministic: true,
  };
}

// ─── Main Compilation Pipeline ───────────────────────────────────────────────
function compile() {
  const compilerVersion = '0.1.0';
  const claimsPath = path.join(__dirname, 'claims.json');
  const outputPath = path.join(__dirname, 'compilation.json');

  // Read claims
  if (!fs.existsSync(claimsPath)) {
    console.error('Error: claims.json not found. Run /init first.');
    process.exit(1);
  }

  const raw = fs.readFileSync(claimsPath, 'utf8');
  const claimsData = JSON.parse(raw);
  const claims = claimsData.claims || [];
  const meta = claimsData.meta || {};

  // Run passes
  const schemaErrors = validateSchema(claims);
  const typeErrors = validateTypes(claims);
  const allValidationErrors = [...schemaErrors, ...typeErrors];

  // Only run conflict/resolution if validation passes
  let conflictGraph = { resolved: [], unresolved: [] };
  let coverage = {};
  let readiness = { blockers: allValidationErrors, warnings: [] };
  let resolvedClaims = claims.filter(c => c.status === 'active' || c.status === 'resolved');

  if (allValidationErrors.length === 0) {
    const sortedClaims = sortByEvidenceTier(claims);
    const conflicts = detectConflicts(sortedClaims);
    conflictGraph = autoResolve(claims, conflicts);
    coverage = analyzeCoverage(claims);
    readiness = checkReadiness([], conflictGraph.unresolved, coverage);
    resolvedClaims = claims.filter(c => c.status === 'active' || c.status === 'resolved');
  }

  const phaseSummary = summarizePhases(claims);
  const certificate = generateCertificate(claimsData, compilerVersion);

  // Determine overall status
  const status = readiness.blockers.length > 0 ? 'blocked' : 'ready';

  // Determine current phase from meta or infer from claims
  const currentPhase = meta.phase || inferPhase(phaseSummary);

  const compilation = {
    compiled_at: new Date().toISOString(),
    claims_hash: certificate.input_hash.slice(7, 14),
    compiler_version: compilerVersion,
    status,
    errors: readiness.blockers,
    warnings: readiness.warnings,
    resolved_claims: resolvedClaims,
    conflict_graph: conflictGraph,
    coverage,
    phase_summary: phaseSummary,
    sprint_meta: {
      question: meta.question || '',
      audience: meta.audience || [],
      initiated: meta.initiated || '',
      phase: currentPhase,
      total_claims: claims.length,
      active_claims: claims.filter(c => c.status === 'active').length,
      conflicted_claims: claims.filter(c => c.status === 'conflicted').length,
      superseded_claims: claims.filter(c => c.status === 'superseded').length,
      connectors: meta.connectors || [],
    },
    compilation_certificate: certificate,
  };

  // Write compilation.json
  fs.writeFileSync(outputPath, JSON.stringify(compilation, null, 2));

  return compilation;
}

function inferPhase(phaseSummary) {
  // Walk backwards through phases to find the latest completed one
  const phases = ['evaluate', 'prototype', 'research', 'define'];
  for (const phase of phases) {
    if (phaseSummary[phase] && phaseSummary[phase].complete) {
      return phase;
    }
  }
  return 'init';
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const compilation = compile();

if (args.includes('--summary')) {
  const c = compilation;
  const statusIcon = c.status === 'ready' ? '\u2713' : '\u2717';
  console.log(`\nWheat Compiler v${c.compiler_version}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`Sprint: ${c.sprint_meta.question || '(not initialized)'}`);
  console.log(`Phase:  ${c.sprint_meta.phase}`);
  console.log(`Status: ${statusIcon} ${c.status.toUpperCase()}`);
  console.log(`Claims: ${c.sprint_meta.total_claims} total, ${c.sprint_meta.active_claims} active, ${c.sprint_meta.conflicted_claims} conflicted`);
  console.log();

  if (Object.keys(c.coverage).length > 0) {
    console.log('Coverage:');
    Object.entries(c.coverage).forEach(([topic, entry]) => {
      const bar = '\u2588'.repeat(Math.min(entry.claims, 10)) + '\u2591'.repeat(Math.max(0, 10 - entry.claims));
      const icon = entry.status === 'strong' ? '\u2713' : entry.status === 'moderate' ? '~' : '\u26A0';
      console.log(`  ${icon} ${topic.padEnd(20)} ${bar} ${entry.max_evidence} (${entry.claims} claims)`);
    });
    console.log();
  }

  if (c.errors.length > 0) {
    console.log('Errors:');
    c.errors.forEach(e => console.log(`  ${e.code}: ${e.message}`));
    console.log();
  }

  if (c.warnings.length > 0) {
    console.log('Warnings:');
    c.warnings.forEach(w => console.log(`  ${w.code}: ${w.message}`));
    console.log();
  }

  console.log(`Certificate: ${c.compilation_certificate.input_hash.slice(0, 20)}...`);
}

if (args.includes('--check')) {
  if (compilation.status === 'blocked') {
    console.error(`Compilation blocked: ${compilation.errors.length} error(s)`);
    compilation.errors.forEach(e => console.error(`  ${e.code}: ${e.message}`));
    process.exit(1);
  } else {
    console.log('Compilation ready.');
    process.exit(0);
  }
}

if (args.includes('--gate')) {
  // Staleness check: is compilation.json older than claims.json?
  const compilationPath = path.join(__dirname, 'compilation.json');
  const claimsPath = path.join(__dirname, 'claims.json');

  if (fs.existsSync(compilationPath) && fs.existsSync(claimsPath)) {
    const compilationMtime = fs.statSync(compilationPath).mtimeMs;
    const claimsMtime = fs.statSync(claimsPath).mtimeMs;

    if (claimsMtime > compilationMtime) {
      console.error('Gate FAILED: compilation.json is stale. Recompiling now...');
      // The compile() call above already refreshed it, so this is informational
    }
  }

  if (compilation.status === 'blocked') {
    console.error(`Gate FAILED: ${compilation.errors.length} blocker(s)`);
    compilation.errors.forEach(e => console.error(`  ${e.code}: ${e.message}`));
    process.exit(1);
  }

  // Print a one-line gate pass for audit
  console.log(`Gate PASSED: ${compilation.sprint_meta.active_claims} claims, ${Object.keys(compilation.coverage).length} topics, hash ${compilation.claims_hash}`);
  process.exit(0);
}
