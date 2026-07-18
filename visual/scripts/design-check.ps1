$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
node (Join-Path $root 'visual/scripts/design-check.mjs')
if ($LASTEXITCODE -ne 0) { throw 'DESIGN_CONTRACT_FAILED: run visual.ps1 design-check -Json for details.' }
