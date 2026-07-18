import { readFile, access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOpenPencil } from './agent-design.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const readJson = async relative => JSON.parse(await readFile(path.join(root, relative), 'utf8'));
const exists = async relative => access(path.join(root, relative)).then(() => true, () => false);
const tokens = await readJson('visual/tokens/core.tokens.json');
const mappings = await readJson('visual/mappings/design-to-code.json');
const baselines = await readJson('visual/lint-baseline.json');
const checks = [];
const check = (id, passed, detail) => checks.push({ id, status: passed ? 'PASSED' : 'FAILED', detail });

for (const group of ['color', 'spacing', 'radius', 'breakpoint']) {
  check(`tokens.${group}`, tokens[group] && Object.keys(tokens[group]).length > 0, `visual/tokens/core.tokens.json#${group}`);
}

const documents = new Map();
for (const [component, mapping] of Object.entries(mappings)) {
  check(`mapping.${component}.designSource`, await exists(mapping.designSource), mapping.designSource);
  check(`mapping.${component}.codeSource`, await exists(mapping.codeSource), mapping.codeSource);
  if (await exists(mapping.designSource) && !documents.has(mapping.designSource)) {
    documents.set(mapping.designSource, await readJson(mapping.designSource));
  }
}

for (const [source, document] of documents) {
  const documentId = path.basename(source, '.pen');
  const nodes = [];
  const visit = (node, parent) => {
    nodes.push({ node, parent });
    for (const child of node.children ?? []) visit(child, node);
  };
  for (const child of document.children ?? []) visit(child, null);

  const ids = nodes.map(({ node }) => node.id).filter(Boolean);
  check(`document.${source}.uniqueIds`, ids.length === new Set(ids).size, `${ids.length} named nodes`);

  const invalidLayouts = nodes.filter(({ node }) => node.layout && !['horizontal', 'vertical', 'grid'].includes(node.layout));
  check(`document.${source}.autoLayout`, invalidLayouts.length === 0, invalidLayouts.map(({ node }) => node.id).join(',') || 'valid');

  const orphanFill = nodes.filter(({ node, parent }) =>
    (node.width === 'fill_container' || node.height === 'fill_container') && !parent?.layout);
  check(`document.${source}.fillContainer`, orphanFill.length === 0, orphanFill.map(({ node }) => node.id).join(',') || 'valid');

  const rootWidths = new Set((document.children ?? []).filter(node => node.type === 'frame').map(node => node.width));
  const missingWidths = Object.values(tokens.breakpoint ?? {}).filter(width => !rootWidths.has(width));
  check(`document.${source}.responsiveFrames`, missingWidths.length === 0, missingWidths.length ? `missing ${missingWidths.join(',')}` : 'desktop,laptop,tablet,mobile');

  for (const [component, mapping] of Object.entries(mappings).filter(([, value]) => value.designSource === source)) {
    const matches = nodes.filter(({ node }) => node.name === component);
    check(`component.${component}`, matches.length > 0, `${matches.length} mapped design nodes`);
  }

  const lint = JSON.parse(await runOpenPencil(['lint', path.join(root, source), '--preset', 'strict', '--json']));
  const rules = [...new Set((lint.messages ?? []).map(message => message.ruleId))].sort();
  const baseline = baselines[documentId];
  const newRules = rules.filter(rule => !baseline?.rules.includes(rule));
  check(`document.${source}.strictLint`, lint.errorCount === 0 && lint.warningCount <= baseline?.warningCount && newRules.length === 0,
    `errors=${lint.errorCount} warnings=${lint.warningCount}/${baseline?.warningCount} newRules=${newRules.join(',') || 'none'}`);

  const variablesOutput = await runOpenPencil(['variables', path.join(root, source), '--json']);
  const variableCount = variablesOutput === 'No variables found.' ? 0 : JSON.parse(variablesOutput).length;
  checks.push({ id: `document.${source}.variables`, status: variableCount > 0 ? 'PASSED' : 'UNAVAILABLE', detail: `${variableCount} variables` });

  const firstFrame = document.children?.find(node => node.type === 'frame');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'llvs-design-check-'));
  try {
    const target = path.join(temp, `${documentId}.svg`);
    await runOpenPencil(['export', path.join(root, source), '--node', firstFrame.id, '--format', 'svg', '--output', target], { timeoutMs: 90_000 });
    check(`document.${source}.exportPreflight`, await exists(path.relative(root, target)) || await access(target).then(() => true, () => false), firstFrame.id);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const failed = checks.filter(item => item.status === 'FAILED');
const report = {
  schemaVersion: 1,
  status: failed.length ? 'NEEDS_FIX' : 'READY',
  supportedFigmaSlice: ['responsive-frames', 'auto-layout-structure', 'component-code-mapping', 'strict-lint-ratchet', 'export-preflight'],
  checks
};

console.log(JSON.stringify(report, null, process.env.LLVS_JSON === '1' ? 0 : 2));
if (failed.length) process.exitCode = 1;
