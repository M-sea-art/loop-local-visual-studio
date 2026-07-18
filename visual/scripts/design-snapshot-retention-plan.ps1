$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') retention-plan
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_SNAPSHOT_RETENTION_PLAN_FAILED' }
