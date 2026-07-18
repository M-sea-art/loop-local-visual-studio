$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') drift-gate
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_SNAPSHOT_DRIFT_GATE_FAILED' }
