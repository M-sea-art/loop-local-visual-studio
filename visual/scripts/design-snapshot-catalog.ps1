$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') catalog
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_SNAPSHOT_CATALOG_FAILED' }
