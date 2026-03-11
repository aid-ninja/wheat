const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const compilerPath = path.resolve(__dirname, '..', 'wheat-compiler.js');
const { compile, EVIDENCE_TIERS, VALID_TYPES } = require(compilerPath);

// Temp file helpers
const tmpFiles = [];
function tmpPath(name) {
  const p = path.join('/tmp', `wheat-test-${process.pid}-${name}`);
  tmpFiles.push(p);
  return p;
}

function writeClaims(name, data) {
  const p = tmpPath(name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return p;
}

function makeClaim(overrides) {
  return {
    id: 'test001',
    type: 'factual',
    topic: 'testing',
    content: 'A test claim.',
    source: { origin: 'test', artifact: null, connector: null },
    evidence: 'web',
    status: 'active',
    phase_added: 'research',
    timestamp: '2026-01-01T00:00:00Z',
    conflicts_with: [],
    resolved_by: null,
    tags: [],
    ...overrides,
  };
}

after(() => {
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// ── 1. Happy path ────────────────────────────────────────────────────────────
describe('happy path', () => {
  it('compiles a valid claims file and produces correct output', () => {
    const input = writeClaims('happy.json', {
      meta: { question: 'test?', phase: 'research' },
      claims: [makeClaim()],
    });
    const output = tmpPath('happy-out.json');
    const result = compile(input, output);

    // Output file is valid JSON
    const onDisk = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.ok(onDisk, 'output file should be valid JSON');

    // status is ready
    assert.equal(result.status, 'ready');

    // compilation_certificate exists
    assert.ok(result.compilation_certificate, 'compilation_certificate should exist');
    assert.ok(result.compilation_certificate.input_hash, 'input_hash should exist');

    // claims_hash is a 7-char hex string
    assert.match(result.claims_hash, /^[0-9a-f]{7}$/, 'claims_hash should be 7 hex chars');
  });
});

// ── 2. Empty claims ──────────────────────────────────────────────────────────
describe('empty claims', () => {
  it('compiles with zero claims and status ready', () => {
    const input = writeClaims('empty.json', { meta: {}, claims: [] });
    const output = tmpPath('empty-out.json');
    const result = compile(input, output);

    assert.equal(result.status, 'ready');
    assert.equal(result.sprint_meta.total_claims, 0);
  });
});

// ── 3. Malformed JSON ────────────────────────────────────────────────────────
describe('malformed JSON', () => {
  it('exits with code 1 on invalid JSON input', () => {
    const badFile = tmpPath('bad.json');
    fs.writeFileSync(badFile, '{not valid json!!!');
    const outFile = tmpPath('bad-out.json');

    let exitCode = 0;
    try {
      execSync(
        `node "${compilerPath}" --input "${badFile}" --output "${outFile}"`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 1, 'should exit with code 1 for malformed JSON');
  });
});

// ── 4. Schema validation ─────────────────────────────────────────────────────
describe('schema validation', () => {
  it('blocks compilation with E_SCHEMA when required fields are missing', () => {
    const input = writeClaims('schema.json', {
      meta: {},
      claims: [{ id: 'bad001' }],  // missing type, topic, content, source, evidence, status
    });
    const output = tmpPath('schema-out.json');
    const result = compile(input, output);

    assert.equal(result.status, 'blocked');
    const schemaCodes = result.errors.filter(e => e.code === 'E_SCHEMA');
    assert.ok(schemaCodes.length > 0, 'should have at least one E_SCHEMA error');
  });
});

// ── 5. Conflict detection ────────────────────────────────────────────────────
describe('conflict detection', () => {
  it('blocks when two claims conflict at the same evidence tier', () => {
    const claimA = makeClaim({
      id: 'c001',
      evidence: 'web',
      conflicts_with: ['c002'],
    });
    const claimB = makeClaim({
      id: 'c002',
      evidence: 'web',
      conflicts_with: ['c001'],
    });
    const input = writeClaims('conflict.json', {
      meta: {},
      claims: [claimA, claimB],
    });
    const output = tmpPath('conflict-out.json');
    const result = compile(input, output);

    assert.equal(result.status, 'blocked');
    const conflictErrors = result.errors.filter(e => e.code === 'E_CONFLICT');
    assert.ok(conflictErrors.length > 0, 'should have at least one E_CONFLICT error');
  });
});

// ── 6. Burn residue ──────────────────────────────────────────────────────────
describe('burn residue', () => {
  it('blocks compilation when a burn- prefixed claim is present', () => {
    const burnClaim = makeClaim({ id: 'burn-001' });
    const input = writeClaims('burn.json', {
      meta: {},
      claims: [burnClaim],
    });
    const output = tmpPath('burn-out.json');
    const result = compile(input, output);

    assert.equal(result.status, 'blocked');
    const burnErrors = result.errors.filter(e => e.code === 'E_BURN_RESIDUE');
    assert.ok(burnErrors.length > 0, 'should have at least one E_BURN_RESIDUE error');
  });
});

// ── 7. Determinism ───────────────────────────────────────────────────────────
describe('determinism', () => {
  it('produces identical input_hash for the same input compiled twice', () => {
    const data = {
      meta: { question: 'determinism test' },
      claims: [makeClaim({ id: 'det001' }), makeClaim({ id: 'det002', topic: 'other' })],
    };
    const input = writeClaims('det.json', data);
    const out1 = tmpPath('det-out1.json');
    const out2 = tmpPath('det-out2.json');

    const result1 = compile(input, out1);
    const result2 = compile(input, out2);

    assert.equal(
      result1.compilation_certificate.input_hash,
      result2.compilation_certificate.input_hash,
      'input_hash must be identical across two compilations of the same input'
    );
  });
});

// ── 8. Evidence tier sorting ─────────────────────────────────────────────────
describe('evidence tier sorting', () => {
  it('coverage reflects the highest evidence tier per topic', () => {
    const claims = [
      makeClaim({ id: 'tier-stated', evidence: 'stated', topic: 'sorting' }),
      makeClaim({ id: 'tier-tested', evidence: 'tested', topic: 'sorting' }),
      makeClaim({ id: 'tier-web', evidence: 'web', topic: 'sorting' }),
    ];
    const input = writeClaims('tier.json', { meta: {}, claims });
    const output = tmpPath('tier-out.json');
    const result = compile(input, output);

    // Coverage should reflect max tier
    assert.equal(result.coverage.sorting.max_evidence, 'tested');

    // EVIDENCE_TIERS ordering: tested > web > stated
    assert.ok(EVIDENCE_TIERS.tested > EVIDENCE_TIERS.web, 'tested > web');
    assert.ok(EVIDENCE_TIERS.web > EVIDENCE_TIERS.stated, 'web > stated');

    // All three claims should be in resolved_claims
    const ids = result.resolved_claims.map(c => c.id);
    assert.ok(ids.includes('tier-tested'), 'tier-tested should be present');
    assert.ok(ids.includes('tier-web'), 'tier-web should be present');
    assert.ok(ids.includes('tier-stated'), 'tier-stated should be present');
  });
});
