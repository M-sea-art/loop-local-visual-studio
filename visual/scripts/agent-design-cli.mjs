import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildSnapshotCatalog, createDesignSnapshot, diffDesign, evaluateDesign, inspectDesign, inspectDesignImpact, runRetentionDecisionAudit, runRetentionDecisionPacket, runRetentionEvidenceCatalog, runRetentionEvidenceExport, runRetentionEvidenceGate, runSnapshotDriftGate, runSnapshotRetentionPlan } from './agent-design.mjs';

const [command, requestPath] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '../..');

try {
  if (!['catalog', 'drift-gate', 'retention-plan', 'decision-packet', 'decision-audit', 'evidence-export', 'evidence-catalog', 'evidence-gate'].includes(command) && !requestPath) throw new Error('DESIGN_REQUEST_REQUIRED');
  const request = requestPath ? JSON.parse(await readFile(path.resolve(root, requestPath), 'utf8')) : null;
  const result = command === 'catalog'
    ? await buildSnapshotCatalog(root)
    : command === 'drift-gate'
      ? await runSnapshotDriftGate(root)
    : command === 'retention-plan'
      ? await runSnapshotRetentionPlan(root)
    : command === 'decision-packet'
      ? await runRetentionDecisionPacket(root, request ?? undefined)
    : command === 'decision-audit'
      ? await runRetentionDecisionAudit(root)
    : command === 'evidence-export'
      ? await runRetentionEvidenceExport(root, request ?? undefined)
    : command === 'evidence-catalog'
      ? await runRetentionEvidenceCatalog(root)
    : command === 'evidence-gate'
      ? await runRetentionEvidenceGate(root)
    : command === 'inspect'
    ? await inspectDesign(root, request)
    : command === 'impact'
      ? await inspectDesignImpact(root, request)
    : command === 'snapshot'
      ? await createDesignSnapshot(root, request)
    : command === 'diff'
      ? await diffDesign(root, request)
    : command === 'eval'
      ? await evaluateDesign(root, request)
      : (() => { throw new Error('DESIGN_COMMAND_INVALID'); })();
  console.log(JSON.stringify(result));
  if (result.exitCode) process.exitCode = result.exitCode;
} catch (error) {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'FAILED', errorCode: String(error.message).split(':')[0], error: error.message }));
  process.exitCode = 1;
}
