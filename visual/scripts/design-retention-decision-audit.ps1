$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') decision-audit
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_RETENTION_DECISION_AUDIT_FAILED' }
