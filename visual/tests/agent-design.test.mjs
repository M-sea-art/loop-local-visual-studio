import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveDocument,
  buildDesignImpactReport,
  evaluateDesign,
  semanticDiff,
  assertExpectedHash,
  createSnapshotEnvelope,
  verifySnapshotEnvelope,
  normalizeSemanticDocument,
  resolveSnapshotPath,
  classifyCatalogStatus,
  buildSnapshotCatalog,
  buildSnapshotRetentionPlan,
  createRetentionDecisionPacket,
  verifyRetentionDecisionPacket,
  resolveRetentionDecisionPath,
  evaluateRetentionDecisionAudit,
  createRetentionEvidenceExport,
  verifyRetentionEvidenceExport,
  resolveRetentionEvidencePath,
  evaluateRetentionEvidenceCatalog,
  evaluateRetentionEvidenceGate,
  evaluateSnapshotDriftGate,
  parseOpenPencilJson,
  resolveRequestScript,
  sha256File,
  validateMutationResult,
  writeAtomically
} from '../scripts/agent-design.mjs';

test('design impact reports an exact deterministic component fixture', () => {
  const input = {
    documentId: 'canary', targetId: 'ui.card', sourcePath: 'visual/screens/canary/canary.pen', sourceSha256: 'abc',
    componentMappings: { 'ui.card': { designSource: 'visual/screens/canary/canary.pen', codeSource: 'src/Card.jsx', storybookId: 'card' } },
    document: { children: [
      { id: 'desktop', type: 'frame', name: 'Desktop', children: [{ id: 'd-card', type: 'frame', name: 'ui.card', children: [{ id: 'd-text', type: 'text', name: 'Title', content: 'Hello', boundVariables: { fills: 'brand' } }] }] },
      { id: 'mobile', type: 'frame', name: 'Mobile', children: [{ id: 'm-card', type: 'frame', name: 'ui.card', mainComponentId: 'ui.card' }] }
    ] }
  };
  const expected = {
    codeMappings: [{ codeSource: 'src/Card.jsx', designSource: 'visual/screens/canary/canary.pen', id: 'ui.card', storybookId: 'card' }],
    componentInstances: [
      { id: 'd-card', name: 'ui.card', type: 'frame', viewportId: 'desktop' },
      { id: 'm-card', name: 'ui.card', type: 'frame', viewportId: 'mobile' }
    ],
    crossViewportRepeats: [], directDependencies: [{ id: 'd-text', name: 'Title', parentId: 'd-card', type: 'text', viewportId: 'desktop' }],
    documentId: 'canary', evidence: { mappingPath: 'visual/mappings/design-to-code.json', method: 'registered-source-read-only', sourcePath: 'visual/screens/canary/canary.pen', sourceSha256: 'abc' },
    reverseReferences: [], schemaVersion: 1, status: 'READY', target: { id: 'ui.card', kind: 'component', matchedNodeIds: ['d-card', 'm-card'] },
    textUsage: [{ nodeId: 'd-text', text: 'Hello', viewportId: 'desktop' }],
    variableUsage: [{ bindings: { fills: 'brand' }, nodeId: 'd-text', viewportId: 'desktop' }]
  };
  assert.deepEqual(buildDesignImpactReport(input), expected);
  assert.equal(JSON.stringify(buildDesignImpactReport(input)), JSON.stringify(buildDesignImpactReport(structuredClone(input))));
});

test('design impact covers descendant text changes in every responsive instance', () => {
  const input = {
    documentId: 'sectmain', targetId: 'toj.sectmain.shell', sourcePath: 'visual/screens/sectmain/sectmain.pen', sourceSha256: 'fixture',
    componentMappings: { 'toj.sectmain.shell': { designSource: 'visual/screens/sectmain/sectmain.pen', codeSource: 'src/SectMainPage.jsx' } },
    document: { children: ['desktop', 'laptop', 'tablet', 'mobile'].map(viewport => ({ id: viewport, type: 'frame', children: [
      { id: `${viewport}-shell`, type: 'frame', name: 'toj.sectmain.shell', children: [{ id: `${viewport}-text`, type: 'text', content: viewport }] }
    ] })) }
  };
  const baseline = JSON.stringify(buildDesignImpactReport(input));
  assert.deepEqual(buildDesignImpactReport(input).componentInstances.map(item => item.viewportId), ['desktop', 'laptop', 'mobile', 'tablet']);
  for (const viewport of ['desktop', 'laptop', 'tablet', 'mobile']) {
    const changed = structuredClone(input);
    changed.document.children.find(item => item.id === viewport).children[0].children[0].content += '-changed';
    assert.notEqual(JSON.stringify(buildDesignImpactReport(changed)), baseline, `${viewport} descendant mutation must change impact`);
  }
});

test('design impact fails closed for unknown and ambiguous targets', () => {
  const base = { documentId: 'canary', targetId: 'missing', sourcePath: 'canary.pen', sourceSha256: 'abc', componentMappings: {}, document: { children: [{ id: 'root', type: 'frame' }] } };
  assert.throws(() => buildDesignImpactReport(base), /DESIGN_IMPACT_TARGET_UNKNOWN/);
  assert.throws(() => buildDesignImpactReport({ ...base, targetId: 'duplicate', document: { children: [{ id: 'duplicate' }, { id: 'duplicate' }] } }), /DESIGN_IMPACT_TARGET_AMBIGUOUS/);
});

test('retention evidence gate passes exactly one complete current chain', () => {
  const result = evaluateRetentionEvidenceGate({ status: 'CURRENT', summary: { currentCount: 1 }, plan: { currentEvidenceExists: true }, documents: [{ documentId: 'canary', currentEvidenceExists: true }], entries: [{ path: 'current.json', classification: 'CURRENT', duplicateOf: null }] });
  assert.deepEqual(result, { schemaVersion: 1, gateVersion: 1, status: 'PASSED', exitCode: 0, errorCode: null, separation: { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED' }, summary: { registeredDocumentCount: 1, currentEvidenceCount: 1, issueCount: 0 }, issues: [] });
});

test('retention evidence gate fails closed with stable precise issues', () => {
  const result = evaluateRetentionEvidenceGate({ status: 'CURRENT_WITH_ISSUES', summary: { currentCount: 2 }, plan: { currentEvidenceExists: true }, documents: [{ documentId: 'canary', currentEvidenceExists: false }], entries: [
    { path: 'duplicate.json', classification: 'CURRENT', duplicateOf: 'current.json' },
    { path: 'stale.json', classification: 'STALE', duplicateOf: null },
    { path: 'tampered.json', classification: 'TAMPERED', duplicateOf: null },
    { path: 'invalid.json', classification: 'PATH_INVALID', duplicateOf: null }
  ] });
  assert.equal(result.status, 'FAILED');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.issues.map(issue => issue.code), ['CURRENT_EVIDENCE_COUNT_INVALID', 'CURRENT_WITH_ISSUES', 'DUPLICATE_CURRENT_EVIDENCE', 'MISSING_CURRENT_DOCUMENT_EVIDENCE', 'PATH_INVALID', 'STALE', 'TAMPERED']);
  assert.equal(JSON.stringify(result), JSON.stringify(evaluateRetentionEvidenceGate(structuredClone({ status: 'CURRENT_WITH_ISSUES', summary: { currentCount: 2 }, plan: { currentEvidenceExists: true }, documents: [{ documentId: 'canary', currentEvidenceExists: false }], entries: [
    { path: 'duplicate.json', classification: 'CURRENT', duplicateOf: 'current.json' }, { path: 'stale.json', classification: 'STALE', duplicateOf: null }, { path: 'tampered.json', classification: 'TAMPERED', duplicateOf: null }, { path: 'invalid.json', classification: 'PATH_INVALID', duplicateOf: null }
  ] }))));
});

test('retention evidence gate reports empty catalog', () => {
  const result = evaluateRetentionEvidenceGate({ status: 'MISSING_CURRENT_EVIDENCE', summary: { currentCount: 0 }, plan: { currentEvidenceExists: false }, documents: [], entries: [] });
  assert.equal(result.errorCode, 'MISSING_CURRENT_EVIDENCE');
  assert.deepEqual(result.issues.map(issue => issue.code), ['CURRENT_EVIDENCE_COUNT_INVALID', 'MISSING_CURRENT_EVIDENCE', 'MISSING_CURRENT_PLAN_EVIDENCE']);
});

test('retention evidence gate preserves catalog failure classifications', () => {
  const cases = [
    ['STALE', [{ path: 'stale.json', classification: 'STALE', duplicateOf: null }]],
    ['TAMPERED', [{ path: 'tampered.json', classification: 'TAMPERED', duplicateOf: null }]],
    ['PATH_INVALID', [{ path: 'invalid.json', classification: 'PATH_INVALID', duplicateOf: null }]],
    ['CURRENT_WITH_ISSUES', [{ path: 'current.json', classification: 'CURRENT', duplicateOf: null }, { path: 'duplicate.json', classification: 'CURRENT', duplicateOf: 'current.json' }]]
  ];
  for (const [status, entries] of cases) {
    const result = evaluateRetentionEvidenceGate({ status, summary: { currentCount: status === 'CURRENT_WITH_ISSUES' ? 2 : 0 }, plan: { currentEvidenceExists: status === 'CURRENT_WITH_ISSUES' }, documents: [], entries });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.exitCode, 1);
    assert.equal(result.errorCode, status);
  }
});

test('retention evidence catalog reports missing and current coverage', () => {
  const current = createRetentionEvidenceExport({ catalog: { schemaVersion: 1, status: 'READY', registeredDocumentCount: 1, documents: [{ documentId: 'canary', sourcePath: 'canary.pen', sourceSha256: 'source', snapshots: [] }], orphanSnapshots: [] }, gate: { status: 'PASSED' }, plan: { status: 'READY' }, packet: {}, audit: { status: 'NO_ACTION_REQUIRED' } });
  const missing = evaluateRetentionEvidenceCatalog(current, []);
  assert.equal(missing.status, 'MISSING_CURRENT_EVIDENCE');
  assert.equal(missing.exitCode, 1);
  assert.deepEqual(missing.documents, [{ documentId: 'canary', sourceSha256: 'source', currentEvidenceExists: false }]);
  const healthy = evaluateRetentionEvidenceCatalog(current, [{ path: 'a.evidence.json', evidence: current }]);
  assert.equal(healthy.status, 'CURRENT');
  assert.equal(healthy.exitCode, 0);
  assert.equal(healthy.documents[0].currentEvidenceExists, true);
  assert.equal(healthy.plan.currentEvidenceExists, true);
});

test('retention evidence catalog deterministically upgrades current with anomalies', () => {
  const inputs = { catalog: { schemaVersion: 1, status: 'READY', registeredDocumentCount: 0, documents: [], orphanSnapshots: [] }, gate: { status: 'PASSED' }, plan: { status: 'READY' }, packet: {}, audit: { status: 'NO_ACTION_REQUIRED' } };
  const current = createRetentionEvidenceExport(inputs);
  const stale = createRetentionEvidenceExport({ ...inputs, plan: { status: 'changed' } });
  const tampered = structuredClone(current);
  tampered.payload.inputHashes.planSha256 = 'tampered';
  const result = evaluateRetentionEvidenceCatalog(current, [
    { path: 'z-path.json', errorCode: 'RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT' },
    { path: 'b-current-copy.json', evidence: current },
    { path: 'a-current.json', evidence: current },
    { path: 'd-tampered.json', evidence: tampered },
    { path: 'c-stale.json', evidence: stale }
  ]);
  assert.equal(result.status, 'CURRENT_WITH_ISSUES');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.entries.map(entry => entry.classification), ['CURRENT', 'CURRENT', 'STALE', 'TAMPERED', 'PATH_INVALID']);
  assert.equal(result.entries[1].duplicateOf, 'a-current.json');
});

test('retention evidence export is deterministic and binds the existing machine chain', () => {
  const inputs = {
    catalog: { schemaVersion: 1, status: 'READY', registeredDocumentCount: 1, documents: [{ documentId: 'canary', sourcePath: 'canary.pen', sourceSha256: 'source', snapshots: [{ path: 'snapshot.json', snapshotFileSha256: 'snapshot', integritySha256: 'integrity', integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'CURRENT' }] }], orphanSnapshots: [] },
    gate: { schemaVersion: 1, status: 'PASSED', exitCode: 0, summary: { issueCount: 0 }, issues: [] },
    plan: { schemaVersion: 1, status: 'READY', summary: { keepCount: 1 }, documents: [], orphanRecommendations: [] },
    packet: { schemaVersion: 1, status: 'NO_ACTION_REQUIRED', integrity: { value: 'packet-payload' } },
    audit: { schemaVersion: 1, status: 'NO_ACTION_REQUIRED', exitCode: 0, summary: { recordCount: 0 }, records: [] }
  };
  const first = createRetentionEvidenceExport(inputs);
  const second = createRetentionEvidenceExport(structuredClone(inputs));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'READY');
  assert.equal(first.payload.documents[0].sourceSha256, 'source');
  assert.equal(verifyRetentionEvidenceExport(first, second).status, 'VERIFIED');
});

test('retention evidence verify rejects tampering, reports input drift and blocks path escape', async () => {
  const inputs = { catalog: { schemaVersion: 1, status: 'READY', registeredDocumentCount: 0, documents: [], orphanSnapshots: [] }, gate: { status: 'PASSED' }, plan: {}, packet: {}, audit: { status: 'NO_ACTION_REQUIRED' } };
  const evidence = createRetentionEvidenceExport(inputs);
  const changed = createRetentionEvidenceExport({ ...inputs, plan: { changed: true } });
  assert.equal(verifyRetentionEvidenceExport(evidence, changed).status, 'STALE');
  evidence.payload.inputHashes.planSha256 = 'tampered';
  assert.throws(() => verifyRetentionEvidenceExport(evidence, changed), /RETENTION_EVIDENCE_TAMPERED/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-retention-evidence-'));
  await assert.rejects(() => resolveRetentionEvidencePath(root, '../outside.json'), /RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT/);
});

test('retention decision audit reports no action and missing decisions deterministically', () => {
  const emptyPlan = { schemaVersion: 1, planVersion: 1, status: 'READY', summary: {}, documents: [], orphanRecommendations: [] };
  const emptyPacket = createRetentionDecisionPacket(emptyPlan, {}, {});
  assert.deepEqual(evaluateRetentionDecisionAudit(emptyPlan, emptyPacket, []), {
    schemaVersion: 1, auditVersion: 1, status: 'NO_ACTION_REQUIRED', exitCode: 0,
    currentPlanSha256: emptyPacket.payload.planSha256,
    summary: { recordCount: 0, verifiedCount: 0, staleCount: 0, invalidCount: 0, missingDecisionCount: 0, noActionRequiredCount: 1 },
    records: []
  });
  const actionPlan = { ...emptyPlan, status: 'READY_WITH_REVIEW', documents: [{ documentId: 'canary', documentRecommendation: { action: 'REVIEW', reason: 'MISSING_CURRENT_SNAPSHOT', ownerActionRequired: true }, recommendations: [] }] };
  const actionPacket = createRetentionDecisionPacket(actionPlan, {}, {});
  const missing = evaluateRetentionDecisionAudit(actionPlan, actionPacket, []);
  assert.equal(missing.status, 'MISSING_DECISION');
  assert.equal(missing.exitCode, 1);
});

test('retention decision audit classifies verified stale and invalid records', () => {
  const empty = { schemaVersion: 1, planVersion: 1, status: 'READY', summary: {}, documents: [], orphanRecommendations: [] };
  const actionPlan = { ...empty, status: 'READY_WITH_REVIEW', documents: [{ documentId: 'canary', documentRecommendation: { action: 'REVIEW', reason: 'MISSING_CURRENT_SNAPSHOT', ownerActionRequired: true }, recommendations: [] }] };
  const packet = createRetentionDecisionPacket(actionPlan, {}, {});
  const decision = structuredClone(packet.decisionRecordTemplate);
  decision.decisions[0].decision = 'APPROVE';
  const verified = evaluateRetentionDecisionAudit(actionPlan, packet, [{ key: 'b', packetPath: 'b.packet.json', decisionPath: 'b.decision.json', packet, decision }]);
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.records[0].classification, 'VERIFIED');
  assert.equal(evaluateRetentionDecisionAudit(empty, createRetentionDecisionPacket(empty, {}, {}), [{ key: 'b', packetPath: 'b.packet.json', decisionPath: 'b.decision.json', packet, decision }]).status, 'STALE');
  const tampered = structuredClone(packet);
  tampered.payload.planSha256 = 'tampered';
  const invalid = evaluateRetentionDecisionAudit(actionPlan, packet, [{ key: 'a', packetPath: 'a.packet.json', decisionPath: 'a.decision.json', packet: tampered, decision }]);
  assert.equal(invalid.status, 'INVALID');
  assert.equal(invalid.records.find(record => record.classification === 'INVALID').errorCode, 'RETENTION_PACKET_TAMPERED');
});

test('retention decision packet is stable and explicit when no action is required', () => {
  const plan = { schemaVersion: 1, planVersion: 1, status: 'READY', summary: { keepCount: 2 }, documents: [], orphanRecommendations: [] };
  const catalog = { schemaVersion: 1, status: 'READY', registeredDocumentCount: 2, missingCurrentSnapshotDocumentIds: [], documents: [], orphanSnapshots: [] };
  const gate = { schemaVersion: 1, status: 'PASSED', exitCode: 0, summary: { issueCount: 0 }, issues: [] };
  const first = createRetentionDecisionPacket(plan, catalog, gate);
  const second = createRetentionDecisionPacket(structuredClone(plan), structuredClone(catalog), structuredClone(gate));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.status, 'NO_ACTION_REQUIRED');
  assert.deepEqual(first.payload.items, []);
  assert.deepEqual(first.decisionRecordTemplate.decisions, []);
  assert.equal(verifyRetentionDecisionPacket(first, first.decisionRecordTemplate, plan).status, 'NO_ACTION_REQUIRED');
});

test('retention decision packet validates exact owner decisions and detects stale plans', () => {
  const recommendation = { path: 'visual/generated/design-snapshots/stale.semantic.json', action: 'DELETE_CANDIDATE', reason: 'STALE_SOURCE', evidence: { snapshotFileSha256: 'abc' }, ownerActionRequired: true };
  const plan = { schemaVersion: 1, planVersion: 1, status: 'READY_WITH_REVIEW', summary: {}, documents: [{ documentId: 'canary', documentRecommendation: { action: 'REVIEW', reason: 'MISSING_CURRENT_SNAPSHOT', ownerActionRequired: true }, recommendations: [recommendation] }], orphanRecommendations: [] };
  const packet = createRetentionDecisionPacket(plan, { schemaVersion: 1, status: 'READY_WITH_ISSUES', registeredDocumentCount: 1, missingCurrentSnapshotDocumentIds: ['canary'], documents: [], orphanSnapshots: [] }, { schemaVersion: 1, status: 'FAILED', exitCode: 1, summary: { issueCount: 1 }, issues: [{ code: 'SNAPSHOT_STALE' }] });
  const record = structuredClone(packet.decisionRecordTemplate);
  record.decisions = record.decisions.map((item, index) => ({ ...item, decision: index ? 'REJECT' : 'DEFER' }));
  assert.equal(verifyRetentionDecisionPacket(packet, record, plan).status, 'VERIFIED');
  assert.equal(verifyRetentionDecisionPacket(packet, record, { ...plan, status: 'READY' }).status, 'STALE');
  assert.throws(() => verifyRetentionDecisionPacket(packet, { ...record, decisions: [record.decisions[0], record.decisions[0]] }, plan), /RETENTION_DECISION_DUPLICATE/);
  assert.throws(() => verifyRetentionDecisionPacket(packet, { ...record, decisions: record.decisions.slice(1) }, plan), /RETENTION_DECISION_MISSING/);
  assert.throws(() => verifyRetentionDecisionPacket(packet, { ...record, decisions: [...record.decisions, { itemId: 'unknown', decision: 'APPROVE' }] }, plan), /RETENTION_DECISION_UNKNOWN/);
});

test('retention decision packet rejects tampering and path escape', async () => {
  const plan = { schemaVersion: 1, planVersion: 1, status: 'READY', summary: {}, documents: [], orphanRecommendations: [] };
  const packet = createRetentionDecisionPacket(plan, { schemaVersion: 1, documents: [], orphanSnapshots: [] }, { schemaVersion: 1, issues: [] });
  packet.payload.planSha256 = 'tampered';
  assert.throws(() => verifyRetentionDecisionPacket(packet, packet.decisionRecordTemplate, plan), /RETENTION_PACKET_TAMPERED/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-retention-packet-'));
  await assert.rejects(() => resolveRetentionDecisionPath(root, '../outside.json'), /RETENTION_DECISION_OUTSIDE_ALLOWED_ROOT/);
  assert.equal(await resolveRetentionDecisionPath(root, 'visual/generated/retention-decisions/packet.json'), path.join(root, 'visual/generated/retention-decisions/packet.json'));
});

test('snapshot retention plan always keeps current valid snapshots', () => {
  const catalog = {
    schemaVersion: 1,
    registeredDocumentCount: 1,
    documents: [{ documentId: 'canary', sourceSha256: 'current', currentSnapshotExists: true, catalogStatus: 'CURRENT', snapshots: [
      { path: 'current.semantic.json', snapshotFileSha256: 'file-current', integritySha256: 'integrity-current', sourceSha256: 'current', integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'CURRENT' }
    ] }],
    orphanSnapshots: []
  };
  const result = buildSnapshotRetentionPlan(catalog);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.documents[0].recommendations.map(item => [item.action, item.reason, item.ownerActionRequired]), [['KEEP', 'CURRENT_SOURCE_MATCH', false]]);
  assert.deepEqual(result.separation, { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED', execution: 'NOT_PERFORMED' });
  assert.equal(JSON.stringify(result), JSON.stringify(buildSnapshotRetentionPlan(structuredClone(catalog))));
});

test('snapshot retention plan classifies stale duplicates and anomalies conservatively', () => {
  const snapshot = (path, values = {}) => ({ path, snapshotFileSha256: `file-${path}`, integritySha256: `integrity-${path}`, sourceSha256: 'old', integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'STALE', ...values });
  const catalog = {
    schemaVersion: 1,
    registeredDocumentCount: 2,
    documents: [
      { documentId: 'canary', sourceSha256: 'current', currentSnapshotExists: true, catalogStatus: 'CURRENT_WITH_ISSUES', snapshots: [
        snapshot('current.semantic.json', { sourceSha256: 'current', sourceStatus: 'CURRENT' }),
        snapshot('stale-a.semantic.json', { snapshotFileSha256: 'duplicate' }),
        snapshot('stale-b.semantic.json', { snapshotFileSha256: 'duplicate' }),
        snapshot('tampered.semantic.json', { integrityStatus: 'TAMPERED', ownershipStatus: 'UNKNOWN', sourceStatus: 'UNKNOWN' }),
        snapshot('mismatch.semantic.json', { ownershipStatus: 'MISMATCH', sourceStatus: 'UNKNOWN' })
      ] },
      { documentId: 'sectmain', sourceSha256: 'sect-current', currentSnapshotExists: false, catalogStatus: 'MISSING', snapshots: [] }
    ],
    orphanSnapshots: [snapshot('orphan.semantic.json')]
  };
  const result = buildSnapshotRetentionPlan(catalog);
  assert.equal(result.status, 'READY_WITH_REVIEW');
  assert.deepEqual(result.documents[0].recommendations.map(item => [item.path, item.action, item.reason]), [
    ['current.semantic.json', 'KEEP', 'CURRENT_SOURCE_MATCH'],
    ['mismatch.semantic.json', 'QUARANTINE_CANDIDATE', 'OWNERSHIP_MISMATCH'],
    ['stale-a.semantic.json', 'DELETE_CANDIDATE', 'STALE_SOURCE'],
    ['stale-b.semantic.json', 'DELETE_CANDIDATE', 'DUPLICATE_SNAPSHOT'],
    ['tampered.semantic.json', 'QUARANTINE_CANDIDATE', 'INTEGRITY_FAILED']
  ]);
  assert.deepEqual(result.documents[1].documentRecommendation, { action: 'REVIEW', reason: 'MISSING_CURRENT_SNAPSHOT', ownerActionRequired: true });
  assert.deepEqual(result.orphanRecommendations.map(item => [item.action, item.reason]), [['QUARANTINE_CANDIDATE', 'ORPHAN_SNAPSHOT']]);
  assert.deepEqual(result.summary, { registeredDocumentCount: 2, snapshotCount: 6, keepCount: 1, deleteCandidateCount: 2, quarantineCandidateCount: 3, reviewDocumentCount: 1, ownerActionRequiredCount: 6 });
});

test('snapshot drift gate passes a healthy catalog and stays separate from approval', () => {
  const result = evaluateSnapshotDriftGate({ schemaVersion: 1, registeredDocumentCount: 1, documents: [{ documentId: 'canary', currentSnapshotExists: true, catalogStatus: 'CURRENT', snapshots: [] }], orphanSnapshots: [] });
  assert.deepEqual(result, {
    schemaVersion: 1,
    gateVersion: 1,
    status: 'PASSED',
    exitCode: 0,
    separation: { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED' },
    summary: { registeredDocumentCount: 1, issueCount: 0, missingCurrentDocumentCount: 0 },
    issues: []
  });
});

test('snapshot drift gate deterministically reports coexisting catalog issues', () => {
  const catalog = {
    schemaVersion: 1,
    registeredDocumentCount: 2,
    documents: [
      { documentId: 'canary', currentSnapshotExists: true, catalogStatus: 'CURRENT_WITH_ISSUES', snapshots: [
        { path: 'z-tampered', integrityStatus: 'TAMPERED', ownershipStatus: 'UNKNOWN', sourceStatus: 'UNKNOWN' },
        { path: 'a-current', integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'CURRENT' }
      ] },
      { documentId: 'sectmain', currentSnapshotExists: false, catalogStatus: 'STALE', snapshots: [
        { path: 'b-stale', integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'STALE' },
        { path: 'c-mismatch', integrityStatus: 'VALID', ownershipStatus: 'MISMATCH', sourceStatus: 'UNKNOWN' }
      ] }
    ],
    orphanSnapshots: [{ path: 'orphan', integrityStatus: 'VALID' }]
  };
  const result = evaluateSnapshotDriftGate(catalog);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.issues.map(issue => issue.code), ['MISSING_CURRENT_SNAPSHOT', 'ORPHAN_SNAPSHOT', 'SNAPSHOT_OWNERSHIP_MISMATCH', 'SNAPSHOT_STALE', 'SNAPSHOT_TAMPERED']);
  assert.equal(JSON.stringify(result), JSON.stringify(evaluateSnapshotDriftGate(structuredClone(catalog))));
});

test('snapshot catalog classifies current, missing, stale, tampered and ownership mismatch', () => {
  const validCurrent = { integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'CURRENT' };
  const validStale = { integrityStatus: 'VALID', ownershipStatus: 'MATCH', sourceStatus: 'STALE' };
  const tampered = { integrityStatus: 'TAMPERED', ownershipStatus: 'UNKNOWN', sourceStatus: 'UNKNOWN' };
  const mismatch = { integrityStatus: 'VALID', ownershipStatus: 'MISMATCH', sourceStatus: 'UNKNOWN' };
  assert.equal(classifyCatalogStatus([]), 'MISSING');
  assert.equal(classifyCatalogStatus([validCurrent]), 'CURRENT');
  assert.equal(classifyCatalogStatus([validStale]), 'STALE');
  assert.equal(classifyCatalogStatus([tampered]), 'TAMPERED');
  assert.equal(classifyCatalogStatus([mismatch]), 'OWNERSHIP_MISMATCH');
  assert.equal(classifyCatalogStatus([tampered, validCurrent]), 'CURRENT_WITH_ISSUES');
});

test('buildSnapshotCatalog reports registered-document snapshot states deterministically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-catalog-'));
  await mkdir(path.join(root, 'visual/mappings'), { recursive: true });
  await mkdir(path.join(root, 'visual/screens/canary'), { recursive: true });
  await mkdir(path.join(root, 'visual/screens/sectmain'), { recursive: true });
  await mkdir(path.join(root, 'visual/generated/design-snapshots'), { recursive: true });
  const canaryPath = path.join(root, 'visual/screens/canary/canary.pen');
  const sectmainPath = path.join(root, 'visual/screens/sectmain/sectmain.pen');
  const canaryDocument = { children: [{ id: 'canary-root', type: 'frame' }] };
  const sectmainDocument = { children: [{ id: 'sect-root', type: 'frame' }] };
  await writeFile(canaryPath, JSON.stringify(canaryDocument));
  await writeFile(sectmainPath, JSON.stringify(sectmainDocument));
  await writeFile(path.join(root, 'visual/mappings/design-to-code.json'), JSON.stringify({
    canary: { designSource: 'visual/screens/canary/canary.pen' },
    sectmain: { designSource: 'visual/screens/sectmain/sectmain.pen' }
  }));
  const canaryHash = await sha256File(canaryPath);
  const snapshot = createSnapshotEnvelope({ documentId: 'canary', sourceSha256: canaryHash, document: canaryDocument, componentMappings: {}, lint: {}, provenance: { runId: 'fixture' } });
  await writeFile(path.join(root, `visual/generated/design-snapshots/canary-${canaryHash}.semantic.json`), JSON.stringify(snapshot));
  const first = await buildSnapshotCatalog(root);
  const second = await buildSnapshotCatalog(root);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.documents.map(item => [item.documentId, item.catalogStatus]), [['canary', 'CURRENT'], ['sectmain', 'MISSING']]);
  assert.deepEqual(first.missingCurrentSnapshotDocumentIds, ['sectmain']);
});

test('semantic snapshot is deterministic and integrity bound', async () => {
  const document = { children: [{ name: 'Root', id: 'root', type: 'frame', fill: '#fff', children: [{ content: 'Hi', type: 'text', id: 'text', boundVariables: { fills: 'v1' } }] }] };
  const provenance = { tool: 'LLVS', command: 'design-snapshot', createdAt: '2026-07-13T00:00:00.000Z', runId: 'test' };
  const first = createSnapshotEnvelope({ documentId: 'canary', sourceSha256: 'abc', document, componentMappings: {}, lint: { errorCount: 0, warningCount: 1, messages: [{ ruleId: 'rule-b' }, { ruleId: 'rule-a' }] }, provenance });
  const second = createSnapshotEnvelope({ documentId: 'canary', sourceSha256: 'abc', document: structuredClone(document), componentMappings: {}, lint: { errorCount: 0, warningCount: 1, messages: [{ ruleId: 'rule-b' }, { ruleId: 'rule-a' }] }, provenance });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(verifySnapshotEnvelope(first), first.payload);
  assert.deepEqual(first.payload.variableReferences, [{ nodeId: 'text', bindings: { fills: 'v1' } }]);
});

test('semantic snapshot rejects tampering', () => {
  const snapshot = createSnapshotEnvelope({ documentId: 'canary', sourceSha256: 'abc', document: { children: [] }, componentMappings: {}, lint: {}, provenance: {} });
  snapshot.payload.documentId = 'sectmain';
  assert.throws(() => verifySnapshotEnvelope(snapshot), /DESIGN_SNAPSHOT_TAMPERED/);
});

test('verified snapshot semantic tree reports controlled fixture drift precisely', () => {
  const base = { children: [{ id: 'root', type: 'frame', layout: 'vertical', children: [{ id: 'text', type: 'text', content: 'Before' }] }] };
  const snapshot = createSnapshotEnvelope({ documentId: 'canary', sourceSha256: 'abc', document: base, componentMappings: {}, lint: {}, provenance: {} });
  const target = structuredClone(base);
  target.children[0].layout = 'horizontal';
  target.children[0].children[0].content = 'After';
  const result = semanticDiff(verifySnapshotEnvelope(snapshot).semanticTree, target);
  assert.deepEqual(result.nodes.modified, [
    { id: 'root', changes: [{ property: 'layout', before: 'vertical', after: 'horizontal' }] },
    { id: 'text', changes: [{ property: 'content', before: 'Before', after: 'After' }] }
  ]);
});

test('normalizeSemanticDocument preserves child order with canonical properties', () => {
  const normalized = normalizeSemanticDocument({ children: [{ id: 'b', type: 'text', content: 'B' }, { id: 'a', type: 'text', content: 'A' }] });
  assert.deepEqual(normalized.children.map(node => node.id), ['b', 'a']);
  assert.equal(JSON.stringify(normalized.children[0]), '{"content":"B","id":"b","type":"text"}');
});

test('resolveSnapshotPath rejects path escape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-agent-'));
  await assert.rejects(() => resolveSnapshotPath(root, '../outside.json'), /DESIGN_SNAPSHOT_OUTSIDE_ALLOWED_ROOT/);
  assert.equal(await resolveSnapshotPath(root, 'visual/generated/design-snapshots/canary-x.semantic.json'), path.join(root, 'visual/generated/design-snapshots/canary-x.semantic.json'));
});

test('semanticDiff is empty and deterministic for identical documents', () => {
  const document = { children: [{ id: 'root', type: 'frame', name: 'Root', layout: 'vertical', children: [{ id: 'title', type: 'text', content: 'Hello' }] }] };
  const first = semanticDiff(document, document, { baseMappings: {}, targetMappings: {}, baseLint: { errorCount: 0, warningCount: 1, messages: [] }, targetLint: { errorCount: 0, warningCount: 1, messages: [] } });
  const second = semanticDiff(document, structuredClone(document), { baseMappings: {}, targetMappings: {}, baseLint: { errorCount: 0, warningCount: 1, messages: [] }, targetLint: { errorCount: 0, warningCount: 1, messages: [] } });
  assert.deepEqual(first, { nodes: { added: [], removed: [], modified: [] }, componentMappings: { added: [], removed: [], modified: [] }, lint: [] });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('semanticDiff reports stable node, layout, text, variable reference, mapping and lint changes', () => {
  const base = { children: [
    { id: 'z', type: 'frame', name: 'Removed' },
    { id: 'a', type: 'frame', name: 'Card', layout: 'vertical', gap: 8, boundVariables: { fills: 'VariableID:old' }, children: [{ id: 'text', type: 'text', content: 'Before' }] }
  ] };
  const target = { children: [
    { id: 'a', type: 'frame', name: 'Card', layout: 'horizontal', gap: 16, boundVariables: { fills: 'VariableID:new' }, children: [{ id: 'text', type: 'text', content: 'After' }] },
    { id: 'b', type: 'text', name: 'Added', content: 'New' }
  ] };
  const result = semanticDiff(base, target, {
    baseMappings: { old: { codeSource: 'src/Old.jsx' } },
    targetMappings: { new: { codeSource: 'src/New.jsx' } },
    baseLint: { errorCount: 0, warningCount: 1, messages: [{ ruleId: 'old-rule' }] },
    targetLint: { errorCount: 0, warningCount: 2, messages: [{ ruleId: 'new-rule' }] }
  });
  assert.deepEqual(result.nodes.added.map(node => node.id), ['b']);
  assert.deepEqual(result.nodes.removed.map(node => node.id), ['z']);
  assert.deepEqual(result.nodes.modified.map(node => node.id), ['a', 'text']);
  assert.deepEqual(result.nodes.modified[0].changes.map(change => change.property), ['boundVariables', 'gap', 'layout']);
  assert.deepEqual(result.componentMappings.added.map(item => item.id), ['new']);
  assert.deepEqual(result.componentMappings.removed.map(item => item.id), ['old']);
  assert.deepEqual(result.lint, [{ errorCount: { before: 0, after: 0, delta: 0 }, warningCount: { before: 1, after: 2, delta: 1 }, rules: { added: ['new-rule'], removed: ['old-rule'] } }]);
});

test('assertExpectedHash fails closed on drift', () => {
  assert.doesNotThrow(() => assertExpectedHash('same', 'same', 'base'));
  assert.throws(() => assertExpectedHash('actual', 'expected', 'target'), /DESIGN_SOURCE_CHANGED: target/);
});

test('parseOpenPencilJson normalizes an empty variables response', () => {
  assert.deepEqual(parseOpenPencilJson('No variables found.'), []);
});

test('resolveDocument only returns registered pen sources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-agent-'));
  await mkdir(path.join(root, 'visual/mappings'), { recursive: true });
  await writeFile(path.join(root, 'visual/mappings/design-to-code.json'), JSON.stringify({
    card: { designSource: 'visual/screens/canary/canary.pen', codeSource: 'src/Card.jsx' }
  }));
  assert.equal(await resolveDocument(root, 'canary'), path.join(root, 'visual/screens/canary/canary.pen'));
  await assert.rejects(() => resolveDocument(root, '../secret'), /DESIGN_DOCUMENT_NOT_REGISTERED/);
});

test('resolveRequestScript rejects paths outside generated requests', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-agent-'));
  await assert.rejects(() => resolveRequestScript(root, 'visual/generated/other/change.js'), /DESIGN_SCRIPT_OUTSIDE_ALLOWED_ROOT/);
  assert.equal(
    await resolveRequestScript(root, 'visual/generated/requests/change.js'),
    path.join(root, 'visual/generated/requests/change.js')
  );
});

test('validateMutationResult requires complete node id arrays', () => {
  assert.deepEqual(validateMutationResult({ createdNodeIds: [], mutatedNodeIds: ['a'], removedNodeIds: [] }), {
    createdNodeIds: [], mutatedNodeIds: ['a'], removedNodeIds: []
  });
  assert.throws(() => validateMutationResult({ mutatedNodeIds: [] }), /DESIGN_MUTATION_RESULT_INVALID/);
});

test('writeAtomically replaces content and changes hash', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-agent-'));
  const target = path.join(root, 'design.pen');
  await writeFile(target, 'before');
  const before = await sha256File(target);
  await writeAtomically(target, Buffer.from('after'));
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.notEqual(await sha256File(target), before);
});

test('evaluateDesign fails closed when pen round-trip is unsupported', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'llvs-agent-'));
  await mkdir(path.join(root, 'visual'), { recursive: true });
  await writeFile(path.join(root, 'visual/compatibility.json'), JSON.stringify({ capabilities: { openpencilEvalPenWrite: false } }));
  await assert.rejects(() => evaluateDesign(root, {}), /LLVS_CAPABILITY_NOT_IMPLEMENTED/);
});
