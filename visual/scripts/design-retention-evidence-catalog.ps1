$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') evidence-catalog
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_RETENTION_EVIDENCE_CATALOG_FAILED' }
