$ErrorActionPreference = 'Stop'
if (-not $env:LLVS_REQUEST) { throw 'DESIGN_REQUEST_REQUIRED' }
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') snapshot $env:LLVS_REQUEST
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_SNAPSHOT_FAILED' }
