import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const sha256File = async file => createHash('sha256').update(await readFile(file)).digest('hex');

export function assertExpectedHash(actual, expected, side) {
  if (expected && actual !== expected) throw new Error(`DESIGN_SOURCE_CHANGED: ${side}`);
}

const semanticProperties = [
  'type', 'name', 'x', 'y', 'width', 'height', 'rotation', 'layout', 'layoutMode', 'gap', 'itemSpacing',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'primaryAxisAlignItems',
  'counterAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutSizingHorizontal',
  'layoutSizingVertical', 'content', 'characters', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight',
  'letterSpacing', 'fill', 'fills', 'stroke', 'strokes', 'cornerRadius', 'opacity', 'visible',
  'boundVariables', 'componentId', 'mainComponentId', 'componentProperties', 'variantProperties'
];

const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const hashValue = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function normalizeSemanticDocument(document) {
  const normalizeNode = node => {
    const value = { id: node.id ?? null };
    for (const property of semanticProperties) if (node[property] !== undefined) value[property] = canonical(node[property]);
    if (node.children) value.children = node.children.map(normalizeNode);
    return canonical(value);
  };
  return canonical({ children: (document?.children ?? []).map(normalizeNode) });
}

const lintSummary = lint => {
  const counts = new Map();
  for (const message of lint?.messages ?? []) {
    const key = `${message.ruleId ?? 'unknown'}\u0000${message.severity ?? 'warning'}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return canonical({
    errorCount: lint?.errorCount ?? 0,
    warningCount: lint?.warningCount ?? 0,
    infoCount: lint?.infoCount ?? 0,
    rules: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
      const [ruleId, severity] = key.split('\u0000');
      return { ruleId, severity, count };
    })
  });
};

const collectVariableReferences = document => {
  const references = [];
  const visit = node => {
    if (node.boundVariables && Object.keys(node.boundVariables).length) references.push({ nodeId: node.id, bindings: canonical(node.boundVariables) });
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of document?.children ?? []) visit(child);
  return references.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
};

export function createSnapshotEnvelope({ documentId, sourceSha256, document, componentMappings, lint, provenance }) {
  const payload = canonical({
    documentId,
    sourceSha256,
    semanticTree: normalizeSemanticDocument(document),
    componentMappings: canonical(componentMappings ?? {}),
    variableReferences: collectVariableReferences(document),
    strictLint: lintSummary(lint),
    provenance: canonical(provenance ?? {})
  });
  return { schemaVersion: 1, snapshotVersion: 1, integrity: { algorithm: 'sha256', value: hashValue(payload) }, payload };
}

export function verifySnapshotEnvelope(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot?.snapshotVersion !== 1 || snapshot?.integrity?.algorithm !== 'sha256' || !snapshot.payload) {
    throw new Error('DESIGN_SNAPSHOT_INVALID');
  }
  if (snapshot.integrity.value !== hashValue(snapshot.payload)) throw new Error('DESIGN_SNAPSHOT_TAMPERED');
  return snapshot.payload;
}

export async function resolveSnapshotPath(root, relative) {
  const allowed = path.resolve(root, 'visual/generated/design-snapshots');
  const resolved = path.resolve(root, relative ?? '');
  if (!inside(allowed, resolved) || !resolved.endsWith('.semantic.json')) throw new Error('DESIGN_SNAPSHOT_OUTSIDE_ALLOWED_ROOT');
  return resolved;
}

export function classifyCatalogStatus(snapshots) {
  const current = snapshots.some(item => item.integrityStatus === 'VALID' && item.ownershipStatus === 'MATCH' && item.sourceStatus === 'CURRENT');
  const issues = snapshots.some(item => item.integrityStatus !== 'VALID' || item.ownershipStatus !== 'MATCH');
  if (current) return issues ? 'CURRENT_WITH_ISSUES' : 'CURRENT';
  if (snapshots.some(item => item.integrityStatus === 'TAMPERED' || item.integrityStatus === 'INVALID')) return 'TAMPERED';
  if (snapshots.some(item => item.ownershipStatus === 'MISMATCH')) return 'OWNERSHIP_MISMATCH';
  if (snapshots.some(item => item.integrityStatus === 'VALID' && item.sourceStatus === 'STALE')) return 'STALE';
  return 'MISSING';
}

export async function buildSnapshotCatalog(root) {
  const mappings = JSON.parse(await readFile(path.join(root, 'visual/mappings/design-to-code.json'), 'utf8'));
  const sources = [...new Set(Object.values(mappings).map(value => value.designSource))].sort();
  const documents = [];
  for (const source of sources) {
    const documentId = path.basename(source, '.pen').toLowerCase();
    const registeredPath = await resolveDocument(root, documentId);
    documents.push({ documentId, sourcePath: path.relative(root, registeredPath).replaceAll(path.sep, '/'), sourceSha256: await sha256File(registeredPath), snapshots: [] });
  }
  documents.sort((a, b) => a.documentId.localeCompare(b.documentId));
  const documentMap = new Map(documents.map(document => [document.documentId, document]));
  const snapshotRoot = path.join(root, 'visual/generated/design-snapshots');
  const names = await readdir(snapshotRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const actualSnapshotRoot = names.length ? await realpath(snapshotRoot) : snapshotRoot;
  const orphanSnapshots = [];
  for (const name of names.filter(name => name.endsWith('.semantic.json')).sort()) {
    const relativePath = `visual/generated/design-snapshots/${name}`;
    const snapshotPath = await resolveSnapshotPath(root, relativePath);
    const actualPath = await realpath(snapshotPath);
    if (!inside(actualSnapshotRoot, actualPath)) throw new Error('DESIGN_SNAPSHOT_OUTSIDE_ALLOWED_ROOT');
    const match = name.match(/^(.+)-([a-f0-9]{64})\.semantic\.json$/);
    const filenameDocumentId = match?.[1] ?? null;
    const filenameSourceSha256 = match?.[2] ?? null;
    const entry = {
      path: relativePath,
      snapshotFileSha256: await sha256File(snapshotPath),
      filenameDocumentId,
      filenameSourceSha256,
      documentId: null,
      sourceSha256: null,
      integrityStatus: 'INVALID',
      ownershipStatus: 'UNKNOWN',
      sourceStatus: 'UNKNOWN',
      integritySha256: null,
      provenance: null
    };
    try {
      const envelope = JSON.parse(await readFile(snapshotPath, 'utf8'));
      entry.integritySha256 = envelope?.integrity?.value ?? null;
      try {
        const payload = verifySnapshotEnvelope(envelope);
        entry.integrityStatus = 'VALID';
        entry.documentId = payload.documentId;
        entry.sourceSha256 = payload.sourceSha256;
        entry.provenance = canonical(payload.provenance ?? {});
        entry.ownershipStatus = payload.documentId === filenameDocumentId && documentMap.has(filenameDocumentId) ? 'MATCH' : 'MISMATCH';
        const registered = documentMap.get(filenameDocumentId);
        entry.sourceStatus = entry.ownershipStatus === 'MATCH' ? (payload.sourceSha256 === registered.sourceSha256 ? 'CURRENT' : 'STALE') : 'UNKNOWN';
      } catch (error) {
        entry.integrityStatus = error.message === 'DESIGN_SNAPSHOT_TAMPERED' ? 'TAMPERED' : 'INVALID';
      }
    } catch {}
    const owner = documentMap.get(filenameDocumentId);
    if (owner) owner.snapshots.push(entry); else orphanSnapshots.push(entry);
  }
  for (const document of documents) {
    document.snapshots.sort((a, b) => a.path.localeCompare(b.path));
    document.catalogStatus = classifyCatalogStatus(document.snapshots);
    document.currentSnapshotExists = document.snapshots.some(item => item.integrityStatus === 'VALID' && item.ownershipStatus === 'MATCH' && item.sourceStatus === 'CURRENT');
  }
  orphanSnapshots.sort((a, b) => a.path.localeCompare(b.path));
  const missingCurrentSnapshotDocumentIds = documents.filter(document => !document.currentSnapshotExists).map(document => document.documentId);
  return {
    schemaVersion: 1,
    catalogVersion: 1,
    status: missingCurrentSnapshotDocumentIds.length === 0 && orphanSnapshots.length === 0 && documents.every(document => document.catalogStatus === 'CURRENT') ? 'READY' : 'READY_WITH_ISSUES',
    registeredDocumentCount: documents.length,
    missingCurrentSnapshotDocumentIds,
    documents,
    orphanSnapshots
  };
}

export function evaluateSnapshotDriftGate(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.documents) || !Array.isArray(catalog.orphanSnapshots)) throw new Error('DESIGN_SNAPSHOT_CATALOG_INVALID');
  const issues = [];
  for (const document of [...catalog.documents].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    if (!document.currentSnapshotExists) issues.push({ code: 'MISSING_CURRENT_SNAPSHOT', documentId: document.documentId, path: null, catalogStatus: document.catalogStatus });
    for (const snapshot of [...document.snapshots].sort((a, b) => a.path.localeCompare(b.path))) {
      if (snapshot.integrityStatus === 'TAMPERED' || snapshot.integrityStatus === 'INVALID') {
        issues.push({ code: 'SNAPSHOT_TAMPERED', documentId: document.documentId, path: snapshot.path, integrityStatus: snapshot.integrityStatus });
      }
      if (snapshot.ownershipStatus === 'MISMATCH') {
        issues.push({ code: 'SNAPSHOT_OWNERSHIP_MISMATCH', documentId: document.documentId, path: snapshot.path, snapshotDocumentId: snapshot.documentId });
      }
      if (snapshot.integrityStatus === 'VALID' && snapshot.ownershipStatus === 'MATCH' && snapshot.sourceStatus === 'STALE') {
        issues.push({ code: 'SNAPSHOT_STALE', documentId: document.documentId, path: snapshot.path, snapshotSourceSha256: snapshot.sourceSha256, currentSourceSha256: document.sourceSha256 });
      }
    }
  }
  for (const snapshot of [...catalog.orphanSnapshots].sort((a, b) => a.path.localeCompare(b.path))) {
    issues.push({ code: 'ORPHAN_SNAPSHOT', documentId: snapshot.documentId, path: snapshot.path, integrityStatus: snapshot.integrityStatus });
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || String(a.documentId ?? '').localeCompare(String(b.documentId ?? '')) || String(a.path ?? '').localeCompare(String(b.path ?? '')));
  const status = issues.length ? 'FAILED' : 'PASSED';
  return {
    schemaVersion: 1,
    gateVersion: 1,
    status,
    exitCode: status === 'PASSED' ? 0 : 1,
    separation: { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED' },
    summary: {
      registeredDocumentCount: catalog.registeredDocumentCount,
      issueCount: issues.length,
      missingCurrentDocumentCount: catalog.documents.filter(document => !document.currentSnapshotExists).length
    },
    issues
  };
}

export async function runSnapshotDriftGate(root) {
  return evaluateSnapshotDriftGate(await buildSnapshotCatalog(root));
}

const retentionEvidence = (snapshot, currentSourceSha256) => canonical({
  snapshotFileSha256: snapshot.snapshotFileSha256 ?? null,
  integritySha256: snapshot.integritySha256 ?? null,
  sourceSha256: snapshot.sourceSha256 ?? null,
  currentSourceSha256: currentSourceSha256 ?? null,
  integrityStatus: snapshot.integrityStatus ?? 'UNKNOWN',
  ownershipStatus: snapshot.ownershipStatus ?? 'UNKNOWN',
  sourceStatus: snapshot.sourceStatus ?? 'UNKNOWN'
});

const retentionRecommendation = (snapshot, currentSourceSha256, action, reason) => ({
  path: snapshot.path,
  action,
  reason,
  evidence: retentionEvidence(snapshot, currentSourceSha256),
  ownerActionRequired: action !== 'KEEP'
});

export function buildSnapshotRetentionPlan(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.documents) || !Array.isArray(catalog.orphanSnapshots)) throw new Error('DESIGN_SNAPSHOT_CATALOG_INVALID');
  const documents = [...catalog.documents].sort((a, b) => a.documentId.localeCompare(b.documentId)).map(document => {
    const seenStaleFiles = new Set();
    const recommendations = [...document.snapshots].sort((a, b) => a.path.localeCompare(b.path)).map(snapshot => {
      if (snapshot.integrityStatus === 'VALID' && snapshot.ownershipStatus === 'MATCH' && snapshot.sourceStatus === 'CURRENT') {
        return retentionRecommendation(snapshot, document.sourceSha256, 'KEEP', 'CURRENT_SOURCE_MATCH');
      }
      if (snapshot.integrityStatus !== 'VALID') return retentionRecommendation(snapshot, document.sourceSha256, 'QUARANTINE_CANDIDATE', 'INTEGRITY_FAILED');
      if (snapshot.ownershipStatus !== 'MATCH') return retentionRecommendation(snapshot, document.sourceSha256, 'QUARANTINE_CANDIDATE', 'OWNERSHIP_MISMATCH');
      if (snapshot.sourceStatus === 'STALE') {
        const duplicate = seenStaleFiles.has(snapshot.snapshotFileSha256);
        seenStaleFiles.add(snapshot.snapshotFileSha256);
        return retentionRecommendation(snapshot, document.sourceSha256, 'DELETE_CANDIDATE', duplicate ? 'DUPLICATE_SNAPSHOT' : 'STALE_SOURCE');
      }
      return retentionRecommendation(snapshot, document.sourceSha256, 'QUARANTINE_CANDIDATE', 'UNCLASSIFIED_SNAPSHOT');
    });
    return {
      documentId: document.documentId,
      currentSourceSha256: document.sourceSha256,
      catalogStatus: document.catalogStatus,
      currentSnapshotExists: document.currentSnapshotExists,
      documentRecommendation: document.currentSnapshotExists
        ? { action: 'KEEP_STATE', reason: 'CURRENT_SNAPSHOT_PRESENT', ownerActionRequired: false }
        : { action: 'REVIEW', reason: 'MISSING_CURRENT_SNAPSHOT', ownerActionRequired: true },
      recommendations
    };
  });
  const orphanRecommendations = [...catalog.orphanSnapshots].sort((a, b) => a.path.localeCompare(b.path))
    .map(snapshot => retentionRecommendation(snapshot, null, 'QUARANTINE_CANDIDATE', 'ORPHAN_SNAPSHOT'));
  const allRecommendations = [...documents.flatMap(document => document.recommendations), ...orphanRecommendations];
  const reviewDocumentCount = documents.filter(document => document.documentRecommendation.action === 'REVIEW').length;
  const count = action => allRecommendations.filter(item => item.action === action).length;
  const ownerActionRequiredCount = allRecommendations.filter(item => item.ownerActionRequired).length + reviewDocumentCount;
  return {
    schemaVersion: 1,
    planVersion: 1,
    status: ownerActionRequiredCount ? 'READY_WITH_REVIEW' : 'READY',
    separation: { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED', execution: 'NOT_PERFORMED' },
    summary: {
      registeredDocumentCount: catalog.registeredDocumentCount,
      snapshotCount: allRecommendations.length,
      keepCount: count('KEEP'),
      deleteCandidateCount: count('DELETE_CANDIDATE'),
      quarantineCandidateCount: count('QUARANTINE_CANDIDATE'),
      reviewDocumentCount,
      ownerActionRequiredCount
    },
    documents,
    orphanRecommendations
  };
}

export async function runSnapshotRetentionPlan(root) {
  return buildSnapshotRetentionPlan(await buildSnapshotCatalog(root));
}

const decisionItem = (documentId, recommendation) => {
  const reference = canonical({
    documentId: documentId ?? null,
    path: recommendation.path ?? null,
    action: recommendation.action,
    reason: recommendation.reason,
    evidence: recommendation.evidence ?? null
  });
  return { itemId: hashValue(reference), ...reference };
};

export function createRetentionDecisionPacket(plan, catalog, gate) {
  if (plan?.schemaVersion !== 1 || !Array.isArray(plan.documents) || !Array.isArray(plan.orphanRecommendations)) throw new Error('RETENTION_PLAN_INVALID');
  const items = [];
  for (const document of [...plan.documents].sort((a, b) => a.documentId.localeCompare(b.documentId))) {
    if (document.documentRecommendation?.action === 'REVIEW') items.push(decisionItem(document.documentId, document.documentRecommendation));
    for (const recommendation of [...document.recommendations].sort((a, b) => a.path.localeCompare(b.path))) {
      if (recommendation.ownerActionRequired) items.push(decisionItem(document.documentId, recommendation));
    }
  }
  for (const recommendation of [...plan.orphanRecommendations].sort((a, b) => a.path.localeCompare(b.path))) items.push(decisionItem(null, recommendation));
  items.sort((a, b) => a.itemId.localeCompare(b.itemId));
  const payload = canonical({
    planSha256: hashValue(plan),
    catalogSummary: {
      status: catalog?.status ?? null,
      registeredDocumentCount: catalog?.registeredDocumentCount ?? null,
      missingCurrentSnapshotDocumentIds: [...(catalog?.missingCurrentSnapshotDocumentIds ?? [])].sort(),
      orphanSnapshotCount: catalog?.orphanSnapshots?.length ?? 0
    },
    driftGateSummary: {
      status: gate?.status ?? null,
      exitCode: gate?.exitCode ?? null,
      summary: canonical(gate?.summary ?? {}),
      issueCodes: [...(gate?.issues ?? [])].map(issue => issue.code).sort()
    },
    items
  });
  const packetSha256 = hashValue(payload);
  return {
    schemaVersion: 1,
    packetVersion: 1,
    status: items.length ? 'ACTION_REQUIRED' : 'NO_ACTION_REQUIRED',
    integrity: { algorithm: 'sha256', value: packetSha256 },
    payload,
    decisionRecordTemplate: {
      schemaVersion: 1,
      packetSha256,
      planSha256: payload.planSha256,
      decisions: items.map(item => ({ itemId: item.itemId, decision: null }))
    },
    separation: { ownerRetentionDecision: 'NOT_RECORDED', visualBaseline: 'NOT_EVALUATED', execution: 'NOT_PERFORMED' }
  };
}

export function verifyRetentionDecisionPacket(packet, record, currentPlan) {
  if (packet?.schemaVersion !== 1 || packet?.packetVersion !== 1 || packet?.integrity?.algorithm !== 'sha256' || !packet.payload) throw new Error('RETENTION_PACKET_INVALID');
  if (packet.integrity.value !== hashValue(packet.payload)) throw new Error('RETENTION_PACKET_TAMPERED');
  if (packet.payload.planSha256 !== hashValue(currentPlan)) return { schemaVersion: 1, status: 'STALE', exitCode: 1, errorCode: 'RETENTION_PLAN_CHANGED', packetPlanSha256: packet.payload.planSha256, currentPlanSha256: hashValue(currentPlan) };
  if (record?.schemaVersion !== 1 || record.packetSha256 !== packet.integrity.value || record.planSha256 !== packet.payload.planSha256 || !Array.isArray(record.decisions)) throw new Error('RETENTION_DECISION_PLAN_HASH_MISMATCH');
  const expected = new Set(packet.payload.items.map(item => item.itemId));
  const provided = new Set();
  for (const decision of record.decisions) {
    if (provided.has(decision.itemId)) throw new Error('RETENTION_DECISION_DUPLICATE');
    provided.add(decision.itemId);
    if (!expected.has(decision.itemId)) throw new Error('RETENTION_DECISION_UNKNOWN');
    if (!['APPROVE', 'REJECT', 'DEFER'].includes(decision.decision)) throw new Error('RETENTION_DECISION_INVALID');
  }
  if ([...expected].some(itemId => !provided.has(itemId))) throw new Error('RETENTION_DECISION_MISSING');
  return { schemaVersion: 1, status: expected.size ? 'VERIFIED' : 'NO_ACTION_REQUIRED', exitCode: 0, packetSha256: packet.integrity.value, planSha256: packet.payload.planSha256, decisionCount: provided.size };
}

export function evaluateRetentionDecisionAudit(currentPlan, currentPacket, entries) {
  const records = [...entries].sort((a, b) => a.key.localeCompare(b.key)).map(entry => {
    const base = { key: entry.key, packetPath: entry.packetPath ?? null, decisionPath: entry.decisionPath ?? null };
    if (entry.errorCode) return { ...base, classification: 'INVALID', errorCode: entry.errorCode, planSha256: null };
    if (!entry.packet) return { ...base, classification: 'INVALID', errorCode: 'RETENTION_PACKET_MISSING', planSha256: null };
    try {
      if (!entry.decision && entry.packet?.payload?.items?.length) return { ...base, classification: 'MISSING_DECISION', errorCode: 'RETENTION_DECISION_MISSING', planSha256: entry.packet.payload.planSha256 ?? null };
      const result = verifyRetentionDecisionPacket(entry.packet, entry.decision ?? entry.packet.decisionRecordTemplate, currentPlan);
      return { ...base, classification: result.status, errorCode: result.errorCode ?? null, planSha256: entry.packet.payload.planSha256 };
    } catch (error) {
      return { ...base, classification: 'INVALID', errorCode: String(error.message).split(':')[0], planSha256: entry.packet?.payload?.planSha256 ?? null };
    }
  });
  if (currentPacket.payload.items.length && !records.some(record => record.classification === 'VERIFIED')) {
    records.push({ key: null, packetPath: null, decisionPath: null, classification: 'MISSING_DECISION', errorCode: 'RETENTION_DECISION_MISSING', planSha256: currentPacket.payload.planSha256 });
  }
  records.sort((a, b) => String(a.planSha256 ?? '').localeCompare(String(b.planSha256 ?? '')) || String(a.key ?? '').localeCompare(String(b.key ?? '')));
  const count = classification => records.filter(record => record.classification === classification).length;
  const summary = {
    recordCount: records.length,
    verifiedCount: count('VERIFIED'),
    staleCount: count('STALE'),
    invalidCount: count('INVALID'),
    missingDecisionCount: count('MISSING_DECISION'),
    noActionRequiredCount: count('NO_ACTION_REQUIRED') + (records.length === 0 && currentPacket.status === 'NO_ACTION_REQUIRED' ? 1 : 0)
  };
  const status = summary.invalidCount ? 'INVALID'
    : summary.staleCount ? 'STALE'
      : summary.missingDecisionCount ? 'MISSING_DECISION'
        : summary.verifiedCount ? 'VERIFIED'
          : 'NO_ACTION_REQUIRED';
  return { schemaVersion: 1, auditVersion: 1, status, exitCode: ['VERIFIED', 'NO_ACTION_REQUIRED'].includes(status) ? 0 : 1, currentPlanSha256: currentPacket.payload.planSha256, summary, records };
}

export async function resolveRetentionDecisionPath(root, relative) {
  const allowed = path.resolve(root, 'visual/generated/retention-decisions');
  const resolved = path.resolve(root, relative ?? '');
  if (!inside(allowed, resolved) || !resolved.endsWith('.json')) throw new Error('RETENTION_DECISION_OUTSIDE_ALLOWED_ROOT');
  return resolved;
}

export async function runRetentionDecisionPacket(root, request = { operation: 'create' }) {
  const catalog = await buildSnapshotCatalog(root);
  const plan = buildSnapshotRetentionPlan(catalog);
  if (request?.schemaVersion !== undefined && request.schemaVersion !== 1) throw new Error('RETENTION_DECISION_REQUEST_INVALID');
  if ((request?.operation ?? 'create') === 'create') {
    if (request.expectedPlanSha256 && request.expectedPlanSha256 !== hashValue(plan)) throw new Error('RETENTION_PLAN_HASH_MISMATCH');
    return createRetentionDecisionPacket(plan, catalog, evaluateSnapshotDriftGate(catalog));
  }
  if (request?.operation !== 'verify') throw new Error('RETENTION_DECISION_OPERATION_INVALID');
  const allowed = path.resolve(root, 'visual/generated/retention-decisions');
  const allowedReal = await realpath(allowed);
  const readAllowed = async relative => {
    const resolved = await resolveRetentionDecisionPath(root, relative);
    const actual = await realpath(resolved);
    if (!inside(allowedReal, actual)) throw new Error('RETENTION_DECISION_OUTSIDE_ALLOWED_ROOT');
    return JSON.parse(await readFile(actual, 'utf8'));
  };
  return verifyRetentionDecisionPacket(await readAllowed(request.packetPath), await readAllowed(request.decisionPath), plan);
}

export async function runRetentionDecisionAudit(root) {
  const catalog = await buildSnapshotCatalog(root);
  const plan = buildSnapshotRetentionPlan(catalog);
  const currentPacket = createRetentionDecisionPacket(plan, catalog, evaluateSnapshotDriftGate(catalog));
  const directory = path.resolve(root, 'visual/generated/retention-decisions');
  const names = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const pairs = new Map();
  const directoryReal = names.length ? await realpath(directory) : directory;
  for (const name of names.filter(name => /\.(packet|decision)\.json$/.test(name)).sort()) {
    const match = name.match(/^(.*)\.(packet|decision)\.json$/);
    const key = match[1];
    const kind = match[2];
    const relative = `visual/generated/retention-decisions/${name}`;
    const resolved = await resolveRetentionDecisionPath(root, relative);
    const actual = await realpath(resolved);
    if (!inside(directoryReal, actual)) throw new Error('RETENTION_DECISION_OUTSIDE_ALLOWED_ROOT');
    const entry = pairs.get(key) ?? { key };
    entry[`${kind}Path`] = relative;
    try { entry[kind] = JSON.parse(await readFile(actual, 'utf8')); }
    catch { entry.errorCode = `RETENTION_${kind.toUpperCase()}_INVALID_JSON`; }
    pairs.set(key, entry);
  }
  return evaluateRetentionDecisionAudit(plan, currentPacket, [...pairs.values()]);
}

export function createRetentionEvidenceExport({ catalog, gate, plan, packet, audit }) {
  const inputHashes = canonical({
    catalogSha256: hashValue(catalog),
    driftGateSha256: hashValue(gate),
    planSha256: hashValue(plan),
    packetSha256: hashValue(packet),
    auditSha256: hashValue(audit)
  });
  const documents = [...(catalog?.documents ?? [])].sort((a, b) => a.documentId.localeCompare(b.documentId)).map(document => ({
    documentId: document.documentId,
    sourcePath: document.sourcePath,
    sourceSha256: document.sourceSha256,
    snapshots: [...document.snapshots].sort((a, b) => a.path.localeCompare(b.path)).map(snapshot => canonical({
      path: snapshot.path,
      snapshotFileSha256: snapshot.snapshotFileSha256,
      integritySha256: snapshot.integritySha256,
      integrityStatus: snapshot.integrityStatus,
      ownershipStatus: snapshot.ownershipStatus,
      sourceStatus: snapshot.sourceStatus,
      provenance: snapshot.provenance
    }))
  }));
  const payload = canonical({
    inputHashes,
    registeredDocumentCount: catalog?.registeredDocumentCount ?? documents.length,
    documents,
    summaries: {
      catalog: { status: catalog?.status ?? null, missingCurrentSnapshotDocumentIds: [...(catalog?.missingCurrentSnapshotDocumentIds ?? [])].sort(), orphanSnapshotCount: catalog?.orphanSnapshots?.length ?? 0 },
      driftGate: { status: gate?.status ?? null, exitCode: gate?.exitCode ?? null, summary: canonical(gate?.summary ?? {}) },
      retentionPlan: { status: plan?.status ?? null, summary: canonical(plan?.summary ?? {}) },
      decisionPacket: { status: packet?.status ?? null, integritySha256: packet?.integrity?.value ?? null },
      decisionAudit: { status: audit?.status ?? null, exitCode: audit?.exitCode ?? null, summary: canonical(audit?.summary ?? {}) }
    },
    provenance: { tool: 'LLVS', command: 'design-retention-evidence-export', sourceOfTruth: '.pen', timestampsIncluded: false }
  });
  const status = gate?.status === 'PASSED' && ['VERIFIED', 'NO_ACTION_REQUIRED'].includes(audit?.status) ? 'READY' : 'STALE';
  return { schemaVersion: 1, evidenceVersion: 1, status, exitCode: status === 'READY' ? 0 : 1, integrity: { algorithm: 'sha256', value: hashValue(payload) }, payload, separation: { ownerRetentionDecision: 'NOT_EXECUTED', visualBaseline: 'NOT_EVALUATED', execution: 'NOT_PERFORMED' } };
}

export function verifyRetentionEvidenceExport(evidence, currentEvidence) {
  if (evidence?.schemaVersion !== 1 || evidence?.evidenceVersion !== 1 || evidence?.integrity?.algorithm !== 'sha256' || !evidence.payload) throw new Error('RETENTION_EVIDENCE_INVALID');
  if (evidence.integrity.value !== hashValue(evidence.payload)) throw new Error('RETENTION_EVIDENCE_TAMPERED');
  if (currentEvidence?.integrity?.value !== hashValue(currentEvidence?.payload)) throw new Error('RETENTION_EVIDENCE_CURRENT_INVALID');
  const changedInputs = Object.keys(evidence.payload.inputHashes).filter(key => evidence.payload.inputHashes[key] !== currentEvidence.payload.inputHashes[key]).sort();
  if (changedInputs.length || evidence.status !== 'READY' || currentEvidence.status !== 'READY') return { schemaVersion: 1, status: 'STALE', exitCode: 1, errorCode: 'RETENTION_EVIDENCE_INPUT_CHANGED', changedInputs, evidenceSha256: evidence.integrity.value, currentEvidenceSha256: currentEvidence.integrity.value };
  return { schemaVersion: 1, status: 'VERIFIED', exitCode: 0, evidenceSha256: evidence.integrity.value, inputHashes: evidence.payload.inputHashes };
}

export function evaluateRetentionEvidenceCatalog(currentEvidence, candidates) {
  const seenHashes = new Map();
  const entries = [...candidates].sort((a, b) => a.path.localeCompare(b.path)).map(candidate => {
    if (candidate.errorCode === 'RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT') return { path: candidate.path, classification: 'PATH_INVALID', errorCode: candidate.errorCode, integritySha256: null, duplicateOf: null };
    if (candidate.errorCode) return { path: candidate.path, classification: 'TAMPERED', errorCode: candidate.errorCode, integritySha256: null, duplicateOf: null };
    try {
      const verified = verifyRetentionEvidenceExport(candidate.evidence, currentEvidence);
      const integritySha256 = candidate.evidence.integrity.value;
      const duplicateOf = seenHashes.get(integritySha256) ?? null;
      if (!duplicateOf) seenHashes.set(integritySha256, candidate.path);
      return { path: candidate.path, classification: verified.status === 'VERIFIED' ? 'CURRENT' : 'STALE', errorCode: verified.errorCode ?? null, integritySha256, duplicateOf };
    } catch (error) {
      return { path: candidate.path, classification: 'TAMPERED', errorCode: String(error.message).split(':')[0], integritySha256: candidate.evidence?.integrity?.value ?? null, duplicateOf: null };
    }
  });
  const currentPaths = new Set(entries.filter(entry => entry.classification === 'CURRENT').map(entry => entry.path));
  const currentCandidates = candidates.filter(candidate => currentPaths.has(candidate.path));
  const documents = [...currentEvidence.payload.documents].sort((a, b) => a.documentId.localeCompare(b.documentId)).map(document => ({
    documentId: document.documentId,
    sourceSha256: document.sourceSha256,
    currentEvidenceExists: currentCandidates.some(candidate => candidate.evidence.payload.documents.some(item => item.documentId === document.documentId && item.sourceSha256 === document.sourceSha256))
  }));
  const count = classification => entries.filter(entry => entry.classification === classification).length;
  const duplicateHashCount = entries.filter(entry => entry.duplicateOf).length;
  const currentCount = count('CURRENT');
  const issueCount = entries.length - currentCount + duplicateHashCount;
  const status = currentCount
    ? (issueCount ? 'CURRENT_WITH_ISSUES' : 'CURRENT')
    : count('PATH_INVALID') ? 'PATH_INVALID'
      : count('TAMPERED') ? 'TAMPERED'
        : count('STALE') ? 'STALE'
          : 'MISSING_CURRENT_EVIDENCE';
  return {
    schemaVersion: 1,
    catalogVersion: 1,
    status,
    exitCode: status === 'CURRENT' ? 0 : 1,
    currentEvidenceSha256: currentEvidence.integrity.value,
    currentPlanSha256: currentEvidence.payload.inputHashes.planSha256,
    summary: { evidenceCount: entries.length, currentCount, staleCount: count('STALE'), tamperedCount: count('TAMPERED'), pathInvalidCount: count('PATH_INVALID'), duplicateHashCount, issueCount },
    plan: { planSha256: currentEvidence.payload.inputHashes.planSha256, currentEvidenceExists: currentCount > 0 },
    documents,
    entries
  };
}

export function evaluateRetentionEvidenceGate(catalog) {
  const issues = [];
  const add = (code, path = null) => issues.push({ code, path });
  if (catalog.status === 'MISSING_CURRENT_EVIDENCE') add('MISSING_CURRENT_EVIDENCE');
  if (catalog.status === 'CURRENT_WITH_ISSUES') add('CURRENT_WITH_ISSUES');
  for (const entry of catalog.entries) {
    if (entry.duplicateOf) add('DUPLICATE_CURRENT_EVIDENCE', entry.path);
    if (entry.classification === 'STALE') add('STALE', entry.path);
    if (entry.classification === 'TAMPERED') add('TAMPERED', entry.path);
    if (entry.classification === 'PATH_INVALID') add('PATH_INVALID', entry.path);
  }
  if (catalog.summary.currentCount !== 1) add('CURRENT_EVIDENCE_COUNT_INVALID');
  if (!catalog.plan.currentEvidenceExists) add('MISSING_CURRENT_PLAN_EVIDENCE');
  for (const document of catalog.documents) {
    if (!document.currentEvidenceExists) add('MISSING_CURRENT_DOCUMENT_EVIDENCE', document.documentId);
  }
  issues.sort((a, b) => a.code.localeCompare(b.code) || (a.path ?? '').localeCompare(b.path ?? ''));
  return {
    schemaVersion: 1,
    gateVersion: 1,
    status: issues.length ? 'FAILED' : 'PASSED',
    exitCode: issues.length ? 1 : 0,
    errorCode: issues.length ? catalog.status : null,
    separation: { ownerApproval: 'NOT_EVALUATED', visualBaseline: 'NOT_EVALUATED' },
    summary: { registeredDocumentCount: catalog.documents.length, currentEvidenceCount: catalog.summary.currentCount, issueCount: issues.length },
    issues
  };
}

export async function resolveRetentionEvidencePath(root, relative) {
  const allowed = path.resolve(root, 'visual/generated/retention-evidence');
  const resolved = path.resolve(root, relative ?? '');
  if (!inside(allowed, resolved) || !resolved.endsWith('.json')) throw new Error('RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
  return resolved;
}

export async function buildCurrentRetentionEvidence(root) {
  const catalog = await buildSnapshotCatalog(root);
  const gate = evaluateSnapshotDriftGate(catalog);
  const plan = buildSnapshotRetentionPlan(catalog);
  const packet = createRetentionDecisionPacket(plan, catalog, gate);
  const audit = await runRetentionDecisionAudit(root);
  if (audit.currentPlanSha256 !== packet.payload.planSha256) throw new Error('RETENTION_EVIDENCE_INPUT_CHANGED');
  return createRetentionEvidenceExport({ catalog, gate, plan, packet, audit });
}

export async function runRetentionEvidenceExport(root, request = { operation: 'create' }) {
  if (request?.schemaVersion !== undefined && request.schemaVersion !== 1) throw new Error('RETENTION_EVIDENCE_REQUEST_INVALID');
  if ((request?.operation ?? 'create') === 'create') return buildCurrentRetentionEvidence(root);
  if (request?.operation !== 'verify') throw new Error('RETENTION_EVIDENCE_OPERATION_INVALID');
  const allowed = path.resolve(root, 'visual/generated/retention-evidence');
  const evidencePath = await resolveRetentionEvidencePath(root, request.evidencePath);
  const actual = await realpath(evidencePath);
  const allowedReal = await realpath(allowed);
  if (!inside(allowedReal, actual)) throw new Error('RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT');
  return verifyRetentionEvidenceExport(JSON.parse(await readFile(actual, 'utf8')), await buildCurrentRetentionEvidence(root));
}

export async function runRetentionEvidenceCatalog(root) {
  const currentEvidence = await buildCurrentRetentionEvidence(root);
  const directory = path.resolve(root, 'visual/generated/retention-evidence');
  const names = await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const directoryReal = names.length ? await realpath(directory) : directory;
  const candidates = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const relative = `visual/generated/retention-evidence/${name}`;
    const resolved = await resolveRetentionEvidencePath(root, relative);
    try {
      const actual = await realpath(resolved);
      if (!inside(directoryReal, actual)) {
        candidates.push({ path: relative, errorCode: 'RETENTION_EVIDENCE_OUTSIDE_ALLOWED_ROOT' });
        continue;
      }
      try { candidates.push({ path: relative, evidence: JSON.parse(await readFile(actual, 'utf8')) }); }
      catch { candidates.push({ path: relative, errorCode: 'RETENTION_EVIDENCE_INVALID_JSON' }); }
    } catch { candidates.push({ path: relative, errorCode: 'RETENTION_EVIDENCE_PATH_INVALID' }); }
  }
  return evaluateRetentionEvidenceCatalog(currentEvidence, candidates);
}

export async function runRetentionEvidenceGate(root) {
  return evaluateRetentionEvidenceGate(await runRetentionEvidenceCatalog(root));
}

const flattenDocument = document => {
  const nodes = new Map();
  const visit = (node, parentId = null) => {
    if (node?.id) nodes.set(node.id, { node, parentId });
    for (const child of node?.children ?? []) visit(child, node.id ?? parentId);
  };
  for (const child of document?.children ?? []) visit(child);
  return nodes;
};

const nodeSummary = ({ node, parentId }) => ({
  id: node.id,
  type: node.type ?? null,
  name: node.name ?? null,
  parentId,
  variableReferences: canonical(node.boundVariables ?? null),
  componentReference: node.mainComponentId ?? node.componentId ?? null
});

const mappingDiff = (base = {}, target = {}) => {
  const baseIds = Object.keys(base).sort();
  const targetIds = Object.keys(target).sort();
  const added = targetIds.filter(id => !Object.hasOwn(base, id)).map(id => ({ id, value: canonical(target[id]) }));
  const removed = baseIds.filter(id => !Object.hasOwn(target, id)).map(id => ({ id, value: canonical(base[id]) }));
  const modified = baseIds.filter(id => Object.hasOwn(target, id) && !same(base[id], target[id])).map(id => ({ id, before: canonical(base[id]), after: canonical(target[id]) }));
  return { added, removed, modified };
};

const lintDiff = (base = {}, target = {}) => {
  const beforeErrors = base.errorCount ?? 0;
  const afterErrors = target.errorCount ?? 0;
  const beforeWarnings = base.warningCount ?? 0;
  const afterWarnings = target.warningCount ?? 0;
  const beforeRules = [...new Set((base.messages ?? []).map(message => message.ruleId))].sort();
  const afterRules = [...new Set((target.messages ?? []).map(message => message.ruleId))].sort();
  const added = afterRules.filter(rule => !beforeRules.includes(rule));
  const removed = beforeRules.filter(rule => !afterRules.includes(rule));
  if (beforeErrors === afterErrors && beforeWarnings === afterWarnings && added.length === 0 && removed.length === 0) return [];
  return [{
    errorCount: { before: beforeErrors, after: afterErrors, delta: afterErrors - beforeErrors },
    warningCount: { before: beforeWarnings, after: afterWarnings, delta: afterWarnings - beforeWarnings },
    rules: { added, removed }
  }];
};

export function semanticDiff(baseDocument, targetDocument, { baseMappings = {}, targetMappings = {}, baseLint = {}, targetLint = {} } = {}) {
  const base = flattenDocument(baseDocument);
  const target = flattenDocument(targetDocument);
  const baseIds = [...base.keys()].sort();
  const targetIds = [...target.keys()].sort();
  const added = targetIds.filter(id => !base.has(id)).map(id => nodeSummary(target.get(id)));
  const removed = baseIds.filter(id => !target.has(id)).map(id => nodeSummary(base.get(id)));
  const modified = [];
  for (const id of baseIds.filter(id => target.has(id))) {
    const before = base.get(id);
    const after = target.get(id);
    const changes = [];
    if (before.parentId !== after.parentId) changes.push({ property: 'parentId', before: before.parentId, after: after.parentId });
    for (const property of semanticProperties) {
      if (!same(before.node[property], after.node[property])) {
        changes.push({ property, before: canonical(before.node[property] ?? null), after: canonical(after.node[property] ?? null) });
      }
    }
    changes.sort((a, b) => a.property.localeCompare(b.property));
    if (changes.length) modified.push({ id, changes });
  }
  return { nodes: { added, removed, modified }, componentMappings: mappingDiff(baseMappings, targetMappings), lint: lintDiff(baseLint, targetLint) };
}

export async function diffDesign(root, request) {
  if (request?.schemaVersion !== 1 || !request.target?.documentId || (!request.base?.documentId && !request.base?.snapshotPath)) throw new Error('DESIGN_DIFF_REQUEST_INVALID');
  const mappings = JSON.parse(await readFile(path.join(root, 'visual/mappings/design-to-code.json'), 'utf8'));
  const loadLive = async (side, label) => {
    const source = await resolveDocument(root, side.documentId);
    const sourceHash = await sha256File(source);
    assertExpectedHash(sourceHash, side.expectedSha256, label);
    const [document, lintOutput] = await Promise.all([
      readFile(source, 'utf8').then(JSON.parse),
      runOpenPencil(['lint', source, '--preset', 'strict', '--json'])
    ]);
    if (await sha256File(source) !== sourceHash) throw new Error(`DESIGN_SOURCE_CHANGED: ${label}`);
    const relative = path.relative(root, source).replaceAll(path.sep, '/');
    return { documentId: side.documentId, document, mappings: mappingsForSource(mappings, relative), lint: parseOpenPencilJson(lintOutput), descriptor: { documentId: side.documentId, sha256: sourceHash } };
  };
  const target = await loadLive(request.target, 'target');
  let base;
  if (request.base.snapshotPath) {
    const snapshotPath = await resolveSnapshotPath(root, request.base.snapshotPath);
    const snapshotFileHash = await sha256File(snapshotPath);
    assertExpectedHash(snapshotFileHash, request.base.expectedSnapshotSha256, 'snapshot');
    const envelope = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const payload = verifySnapshotEnvelope(envelope);
    if (payload.documentId !== target.documentId) throw new Error('DESIGN_SNAPSHOT_DOCUMENT_MISMATCH');
    base = {
      documentId: payload.documentId,
      document: payload.semanticTree,
      mappings: payload.componentMappings,
      lint: { errorCount: payload.strictLint.errorCount, warningCount: payload.strictLint.warningCount, messages: payload.strictLint.rules.map(rule => ({ ruleId: rule.ruleId })) },
      descriptor: { documentId: payload.documentId, sourceSha256: payload.sourceSha256, snapshotPath: request.base.snapshotPath, snapshotFileSha256: snapshotFileHash, integritySha256: envelope.integrity.value }
    };
  } else {
    base = request.base.documentId === request.target.documentId && request.base.expectedSha256 === request.target.expectedSha256
      ? target
      : await loadLive(request.base, 'base');
  }
  const changes = semanticDiff(base.document, target.document, { baseMappings: base.mappings, targetMappings: target.mappings, baseLint: base.lint, targetLint: target.lint });
  const summary = {
    nodesAdded: changes.nodes.added.length,
    nodesRemoved: changes.nodes.removed.length,
    nodesModified: changes.nodes.modified.length,
    mappingsAdded: changes.componentMappings.added.length,
    mappingsRemoved: changes.componentMappings.removed.length,
    mappingsModified: changes.componentMappings.modified.length,
    lintChanged: changes.lint.length > 0
  };
  return {
    schemaVersion: 1,
    status: 'READY',
    base: base.descriptor,
    target: target.descriptor,
    empty: Object.entries(summary).every(([, value]) => value === 0 || value === false),
    summary,
    changes
  };
}

const mappingsForSource = (mappings, source) => Object.fromEntries(Object.entries(mappings).filter(([, value]) => value.designSource.replaceAll('\\', '/') === source));

export function buildDesignImpactReport({ documentId, targetId, sourcePath, sourceSha256, document, componentMappings }) {
  if (!documentId || !targetId || !sourcePath || !sourceSha256 || !document?.children || !componentMappings) throw new Error('DESIGN_IMPACT_INPUT_INVALID');
  const nodes = [];
  const visit = (node, parentId = null, viewportId = null) => {
    const currentViewportId = viewportId ?? node.id;
    nodes.push({ node, parentId, viewportId: currentViewportId });
    for (const child of node.children ?? []) visit(child, node.id, currentViewportId);
  };
  for (const child of document.children) visit(child);
  const idMatches = nodes.filter(item => item.node.id === targetId);
  const mapping = componentMappings[targetId];
  const instanceMatches = nodes.filter(item => item.node.name === targetId || item.node.componentId === targetId || item.node.mainComponentId === targetId);
  if (idMatches.length > 1 || (idMatches.length && mapping)) throw new Error('DESIGN_IMPACT_TARGET_AMBIGUOUS');
  if (!idMatches.length && !mapping && !instanceMatches.length) throw new Error('DESIGN_IMPACT_TARGET_UNKNOWN');
  const selected = idMatches.length ? idMatches : instanceMatches;
  const selectedIds = new Set(selected.map(item => item.node.id));
  const selectedScopeIds = new Set(selectedIds);
  const includeDescendants = node => {
    for (const child of node.children ?? []) {
      selectedScopeIds.add(child.id);
      includeDescendants(child);
    }
  };
  for (const item of selected) includeDescendants(item.node);
  const targetNames = new Set(selected.map(item => item.node.name).filter(Boolean));
  if (mapping) targetNames.add(targetId);
  const stableNode = item => canonical({ id: item.node.id, name: item.node.name ?? null, type: item.node.type ?? null, viewportId: item.viewportId });
  const directDependencies = selected.flatMap(item => (item.node.children ?? []).map(child => canonical({ id: child.id, name: child.name ?? null, type: child.type ?? null, parentId: item.node.id, viewportId: item.viewportId }))).sort((a, b) => a.id.localeCompare(b.id));
  const reverseReferences = nodes.filter(item => !selectedIds.has(item.node.id) && ([item.node.componentId, item.node.mainComponentId].includes(targetId) || Object.values(item.node.boundVariables ?? {}).some(value => JSON.stringify(value).includes(targetId))))
    .map(stableNode).sort((a, b) => a.id.localeCompare(b.id));
  const componentInstances = nodes.filter(item => targetNames.has(item.node.name) || item.node.componentId === targetId || item.node.mainComponentId === targetId).map(stableNode).sort((a, b) => a.viewportId.localeCompare(b.viewportId) || a.id.localeCompare(b.id));
  const variableUsage = nodes.filter(item => Object.keys(item.node.boundVariables ?? {}).length && (selectedScopeIds.has(item.node.id) || Object.values(item.node.boundVariables).some(value => JSON.stringify(value).includes(targetId))))
    .map(item => canonical({ nodeId: item.node.id, viewportId: item.viewportId, bindings: item.node.boundVariables })).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const textUsage = nodes.filter(item => selectedScopeIds.has(item.node.id) && item.node.type === 'text').map(item => canonical({ nodeId: item.node.id, viewportId: item.viewportId, text: item.node.content ?? item.node.characters ?? '' })).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  const crossViewportRepeats = nodes.filter(item => !selectedIds.has(item.node.id) && targetNames.has(item.node.name)).map(stableNode).sort((a, b) => a.viewportId.localeCompare(b.viewportId) || a.id.localeCompare(b.id));
  const codeMappings = Object.entries(componentMappings).filter(([id]) => id === targetId || targetNames.has(id)).map(([id, value]) => canonical({ id, ...value })).sort((a, b) => a.id.localeCompare(b.id));
  return canonical({ schemaVersion: 1, status: 'READY', documentId, target: { id: targetId, kind: mapping ? 'component' : 'node', matchedNodeIds: [...selectedIds].sort() }, directDependencies, reverseReferences, componentInstances, variableUsage, textUsage, crossViewportRepeats, codeMappings, evidence: { sourcePath, sourceSha256, mappingPath: 'visual/mappings/design-to-code.json', method: 'registered-source-read-only' } });
}

export async function inspectDesignImpact(root, request) {
  if (request?.schemaVersion !== 1 || !request.documentId || !request.targetId) throw new Error('DESIGN_IMPACT_REQUEST_INVALID');
  const source = await resolveDocument(root, request.documentId);
  const sourceSha256 = await sha256File(source);
  assertExpectedHash(sourceSha256, request.expectedSha256, 'source');
  const [document, mappings] = await Promise.all([readFile(source, 'utf8').then(JSON.parse), readFile(path.join(root, 'visual/mappings/design-to-code.json'), 'utf8').then(JSON.parse)]);
  if (await sha256File(source) !== sourceSha256) throw new Error('DESIGN_SOURCE_CHANGED: source');
  const sourcePath = path.relative(root, source).replaceAll(path.sep, '/');
  return buildDesignImpactReport({ documentId: request.documentId, targetId: request.targetId, sourcePath, sourceSha256, document, componentMappings: mappingsForSource(mappings, sourcePath) });
}

export async function createDesignSnapshot(root, request) {
  if (request?.schemaVersion !== 1 || !request.documentId) throw new Error('DESIGN_SNAPSHOT_REQUEST_INVALID');
  const source = await resolveDocument(root, request.documentId);
  const sourceHash = await sha256File(source);
  assertExpectedHash(sourceHash, request.expectedSha256, 'source');
  const [document, mappings, lintOutput] = await Promise.all([
    readFile(source, 'utf8').then(JSON.parse),
    readFile(path.join(root, 'visual/mappings/design-to-code.json'), 'utf8').then(JSON.parse),
    runOpenPencil(['lint', source, '--preset', 'strict', '--json'])
  ]);
  if (await sha256File(source) !== sourceHash) throw new Error('DESIGN_SOURCE_CHANGED: source');
  const sourceRelative = path.relative(root, source).replaceAll(path.sep, '/');
  const envelope = createSnapshotEnvelope({
    documentId: request.documentId,
    sourceSha256: sourceHash,
    document,
    componentMappings: mappingsForSource(mappings, sourceRelative),
    lint: parseOpenPencilJson(lintOutput),
    provenance: {
      tool: 'LLVS',
      command: 'design-snapshot',
      openpencilVersion: '0.13.2',
      createdAt: new Date().toISOString(),
      runId: process.env.LLVS_RUN_ID ?? null
    }
  });
  const directory = path.join(root, 'visual/generated/design-snapshots');
  const target = path.join(directory, `${request.documentId}-${sourceHash}.semantic.json`);
  await mkdir(directory, { recursive: true });
  let reused = false;
  try {
    await writeFile(target, `${JSON.stringify(envelope)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(target, 'utf8'));
    const payload = verifySnapshotEnvelope(existing);
    if (payload.documentId !== request.documentId || payload.sourceSha256 !== sourceHash) throw new Error('DESIGN_SNAPSHOT_TAMPERED');
    reused = true;
  }
  const stored = JSON.parse(await readFile(target, 'utf8'));
  const payload = verifySnapshotEnvelope(stored);
  return {
    schemaVersion: 1,
    status: 'READY',
    reused,
    documentId: payload.documentId,
    sourceSha256: payload.sourceSha256,
    snapshotPath: path.relative(root, target).replaceAll(path.sep, '/'),
    snapshotFileSha256: await sha256File(target),
    integritySha256: stored.integrity.value
  };
}

const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

export async function resolveDocument(root, documentId) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(documentId ?? '')) throw new Error('DESIGN_DOCUMENT_NOT_REGISTERED');
  const mappings = JSON.parse(await readFile(path.join(root, 'visual/mappings/design-to-code.json'), 'utf8'));
  const sources = [...new Set(Object.values(mappings).map(value => value.designSource))];
  const relative = sources.find(source => path.basename(source, '.pen').toLowerCase() === documentId.toLowerCase());
  if (!relative || path.extname(relative).toLowerCase() !== '.pen') throw new Error('DESIGN_DOCUMENT_NOT_REGISTERED');
  const resolved = path.resolve(root, relative);
  if (!inside(root, resolved)) throw new Error('DESIGN_DOCUMENT_NOT_REGISTERED');
  return resolved;
}

export async function resolveRequestScript(root, relative) {
  const allowed = path.resolve(root, 'visual/generated/requests');
  const resolved = path.resolve(root, relative ?? '');
  if (!inside(allowed, resolved) || path.extname(resolved).toLowerCase() !== '.js') {
    throw new Error('DESIGN_SCRIPT_OUTSIDE_ALLOWED_ROOT');
  }
  return resolved;
}

export function validateMutationResult(value) {
  const keys = ['createdNodeIds', 'mutatedNodeIds', 'removedNodeIds'];
  if (!value || keys.some(key => !Array.isArray(value[key]) || value[key].some(id => typeof id !== 'string'))) {
    throw new Error('DESIGN_MUTATION_RESULT_INVALID');
  }
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export async function writeAtomically(target, content) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content);
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function resolveOpenPencil() {
  const appData = process.env.APPDATA;
  if (!appData) throw new Error('OPENPENCIL_RUNTIME_NOT_CONFIGURED');
  return {
    bun: process.env.LLVS_BUN_PATH || 'bun',
    cli: path.join(appData, 'npm/node_modules/@open-pencil/cli/bin/openpencil.js')
  };
}

export function runProcess(command, args, { input, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`PROCESS_TIMEOUT: ${command}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8').trim(), stderr: Buffer.concat(stderr).toString('utf8').trim() });
    });
    child.stdin.end(input);
  });
}

export async function runOpenPencil(args, options) {
  const { bun, cli } = resolveOpenPencil();
  await access(cli).catch(() => { throw new Error('OPENPENCIL_RUNTIME_NOT_CONFIGURED'); });
  const result = await runProcess(bun, [cli, ...args], options);
  if (result.code !== 0) throw new Error(`OPENPENCIL_COMMAND_FAILED: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export const parseOpenPencilJson = output => output === 'No variables found.' ? [] : JSON.parse(output);

export async function inspectDesign(root, request) {
  const document = await resolveDocument(root, request.documentId);
  const commands = {
    tree: ['tree', document, '--json'],
    node: ['node', document, '--id', request.selector, '--json'],
    query: ['query', document, request.selector, '--json'],
    variables: ['variables', document, '--json'],
    lint: ['lint', document, '--preset', 'strict', '--json']
  };
  if (request.schemaVersion !== 1 || !commands[request.operation] || (['node', 'query'].includes(request.operation) && !request.selector)) {
    throw new Error('DESIGN_INSPECT_REQUEST_INVALID');
  }
  const output = await runOpenPencil(commands[request.operation]);
  return { schemaVersion: 1, status: 'READY', documentId: request.documentId, sourceSha256: await sha256File(document), result: parseOpenPencilJson(output) };
}

const parseEvalResult = output => {
  const value = JSON.parse(output);
  return validateMutationResult(value.result ?? value);
};

export async function evaluateDesign(root, request) {
  const compatibility = JSON.parse(await readFile(path.join(root, 'visual/compatibility.json'), 'utf8'));
  if (compatibility.capabilities?.openpencilEvalPenWrite !== true) {
    throw new Error('LLVS_CAPABILITY_NOT_IMPLEMENTED: OpenPencil 0.13.2 eval cannot round-trip .pen files');
  }
  if (request.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(request.mutationId ?? '')) {
    throw new Error('DESIGN_EVAL_REQUEST_INVALID');
  }
  const source = await resolveDocument(root, request.documentId);
  const script = await resolveRequestScript(root, request.scriptPath);
  const beforeHash = await sha256File(source);
  if (beforeHash !== request.expectedSha256) throw new Error('DESIGN_SOURCE_CHANGED');

  const work = path.join(root, 'visual/generated/design-transactions');
  await mkdir(work, { recursive: true });
  const candidate = path.join(work, `${request.mutationId}.pen`);
  const exportPath = path.join(work, `${request.mutationId}.svg`);
  await copyFile(source, candidate);
  try {
    const code = await readFile(script, 'utf8');
    const evalOutput = await runOpenPencil(['eval', candidate, '--stdin', '--write', '--json'], { input: code, timeoutMs: 60_000 });
    const mutation = parseEvalResult(evalOutput);
    const lint = JSON.parse(await runOpenPencil(['lint', candidate, '--preset', 'strict', '--json']));
    if ((lint.errorCount ?? 0) > 0) throw new Error('DESIGN_LINT_FAILED');
    const info = JSON.parse(await runOpenPencil(['info', candidate, '--json']));
    const document = JSON.parse(await readFile(candidate, 'utf8'));
    const firstFrame = document.children?.find(node => node.type === 'frame');
    if (!firstFrame?.id) throw new Error('DESIGN_EXPORT_TARGET_MISSING');
    await runOpenPencil(['export', candidate, '--node', firstFrame.id, '--format', 'svg', '--output', exportPath], { timeoutMs: 90_000 });

    if (await sha256File(source) !== beforeHash) throw new Error('DESIGN_SOURCE_CHANGED');
    await writeAtomically(source, await readFile(candidate));
    const afterHash = await sha256File(source);
    const report = { schemaVersion: 1, status: 'PASSED', mutationId: request.mutationId, documentId: request.documentId, beforeSha256: beforeHash, afterSha256: afterHash, mutation, lint: { errorCount: lint.errorCount, warningCount: lint.warningCount }, info };
    await mkdir(path.join(root, 'visual/generated/runs'), { recursive: true });
    await writeAtomically(path.join(root, 'visual/generated/runs', `${request.mutationId}-design-eval.json`), Buffer.from(JSON.stringify(report, null, 2)));
    return report;
  } finally {
    await rm(candidate, { force: true });
    await rm(exportPath, { force: true });
  }
}
