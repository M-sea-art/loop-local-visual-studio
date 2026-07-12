[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('doctor', 'capabilities')]
    [string]$Command = 'doctor',
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

function Write-LLVSResult {
    param([Parameter(Mandatory = $true)]$Value)

    if ($Json) {
        $Value | ConvertTo-Json -Depth 8
        return
    }

    if ($Value.PSObject.Properties.Name -contains 'status') {
        Write-Output "LLVS status: $($Value.status)"
    }
    if ($Value.PSObject.Properties.Name -contains 'checks') {
        foreach ($check in $Value.checks) {
            $marker = if ($check.ok) { '[ok]' } else { '[missing]' }
            $requirement = if ($check.required) { 'required' } else { 'optional' }
            Write-Output "$marker $($check.name) ($requirement): $($check.detail)"
        }
    } else {
        $Value | ConvertTo-Json -Depth 8
    }
}

if ($Command -eq 'capabilities') {
    $capabilitiesPath = Join-Path $root 'visual/capabilities.json'
    if (-not (Test-Path -LiteralPath $capabilitiesPath)) { throw 'LLVS_CAPABILITIES_NOT_FOUND' }
    $capabilities = Get-Content -LiteralPath $capabilitiesPath -Raw | ConvertFrom-Json
    Write-LLVSResult -Value $capabilities
    return
}

$registryPath = Join-Path $root 'visual/products/registry.json'
$registryOk = $false
$registryDetail = 'visual/products/registry.json is missing or invalid'
if (Test-Path -LiteralPath $registryPath) {
    try {
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json -ErrorAction Stop
        $invalidProducts = @($registry.products | Where-Object {
            $visualSpecProperty = $_.PSObject.Properties['visualSpec']
            -not (Test-Path -LiteralPath (Join-Path $root $_.root)) -or
            ($null -ne $visualSpecProperty -and $visualSpecProperty.Value -and -not (Test-Path -LiteralPath (Join-Path $root $visualSpecProperty.Value)))
        })
        $registryOk = $registry.schemaVersion -eq 1 -and $invalidProducts.Count -eq 0
        $registryDetail = if ($registryOk) {
            "visual/products/registry.json ($(@($registry.products).Count) product fixture(s))"
        } else {
            'visual/products/registry.json has an unsupported version or missing product paths'
        }
    } catch {
        $registryDetail = 'visual/products/registry.json is not valid JSON'
    }
}

$checks = @(
    [ordered]@{ name = 'skill'; required = $true; ok = Test-Path -LiteralPath (Join-Path $root 'skills/llvs/SKILL.md'); detail = 'skills/llvs/SKILL.md' }
    [ordered]@{ name = 'feedback-script'; required = $true; ok = Test-Path -LiteralPath (Join-Path $root 'skills/llvs/scripts/submit-feedback.ps1'); detail = 'skills/llvs/scripts/submit-feedback.ps1' }
    [ordered]@{ name = 'registry'; required = $true; ok = $registryOk; detail = $registryDetail }
    [ordered]@{ name = 'capabilities'; required = $true; ok = Test-Path -LiteralPath (Join-Path $root 'visual/capabilities.json'); detail = 'visual/capabilities.json' }
    [ordered]@{ name = 'schemas'; required = $true; ok = @(Get-ChildItem -LiteralPath (Join-Path $root 'visual/schemas') -Filter '*.schema.json' -ErrorAction SilentlyContinue).Count -ge 4; detail = 'visual/schemas/*.schema.json' }
    [ordered]@{ name = 'powershell-7'; required = $false; ok = $PSVersionTable.PSVersion.Major -ge 7; detail = $PSVersionTable.PSVersion.ToString() }
    [ordered]@{ name = 'git'; required = $false; ok = $null -ne (Get-Command git -ErrorAction SilentlyContinue); detail = 'Required only for Git-backed configuration and development' }
    [ordered]@{ name = 'github-cli'; required = $false; ok = $null -ne (Get-Command gh -ErrorAction SilentlyContinue); detail = 'Required only for explicitly authorized feedback publishing' }
    [ordered]@{ name = 'node'; required = $false; ok = $null -ne (Get-Command node -ErrorAction SilentlyContinue); detail = 'Reserved for future visual runtime adapters' }
    [ordered]@{ name = 'openpencil'; required = $false; ok = $null -ne (Get-Command openpencil -ErrorAction SilentlyContinue); detail = 'Reserved for the planned OpenPencil adapter' }
)

$requiredFailures = @($checks | Where-Object { $_.required -and -not $_.ok })
$result = [ordered]@{
    schemaVersion = 1
    status = if ($requiredFailures.Count -eq 0) { 'READY_CORE' } else { 'NEEDS_FIX' }
    releaseStage = 'public-preview'
    root = $root
    checks = $checks
    next = if ($requiredFailures.Count -eq 0) { 'Run visual.ps1 capabilities -Json before invoking a workflow.' } else { 'Restore the missing required files listed above.' }
}

Write-LLVSResult -Value $result
if ($requiredFailures.Count -gt 0) { exit 1 }
