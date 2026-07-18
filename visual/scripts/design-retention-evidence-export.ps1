$ErrorActionPreference = 'Stop'
$arguments = @('evidence-export')
if ($env:LLVS_REQUEST) { $arguments += $env:LLVS_REQUEST }
node (Join-Path $PSScriptRoot 'agent-design-cli.mjs') @arguments
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_RETENTION_EVIDENCE_EXPORT_FAILED' }
