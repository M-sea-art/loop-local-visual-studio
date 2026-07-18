[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$EvidencePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $EvidencePath)) {
    throw 'LLVS_EVIDENCE_NOT_FOUND'
}

$evidence = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json

$required = @(
    'projectId',
    'viewport',
    'runtime',
    'artifacts',
    'verificationStatus'
)

$missing = @($required | Where-Object {
    -not ($evidence.PSObject.Properties.Name -contains $_)
})

$result = [ordered]@{
    schemaVersion = 1
    status = if ($missing.Count -eq 0) { 'PASS' } else { 'BLOCKED' }
    missing = $missing
}

$result | ConvertTo-Json -Depth 5

if ($missing.Count -gt 0) { exit 1 }
