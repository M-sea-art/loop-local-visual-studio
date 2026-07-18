$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') evidence-gate
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_RETENTION_EVIDENCE_GATE_FAILED' }
