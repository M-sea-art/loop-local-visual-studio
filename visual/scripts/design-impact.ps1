$ErrorActionPreference = 'Stop'
if (-not $env:LLVS_REQUEST) { throw 'DESIGN_REQUEST_REQUIRED' }
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') impact $env:LLVS_REQUEST
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_IMPACT_FAILED' }
