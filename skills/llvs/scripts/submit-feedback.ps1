param(
    [Parameter(Mandatory=$true)][string]$SourceProject,
    [Parameter(Mandatory=$true)][string]$Command,
    [Parameter(Mandatory=$true)][string]$Summary,
    [string]$Detail = '',
    [switch]$LocalOnly
)
$ErrorActionPreference = 'Stop'
$llvsHome = $env:LLVS_HOME
if (-not $llvsHome) { $llvsHome = git config --global --get llvs.home 2>$null }
if (-not $llvsHome -and (Test-Path -LiteralPath (Join-Path (Get-Location) 'visual.ps1'))) { $llvsHome = (Get-Location).Path }
if (-not $llvsHome) { throw 'LLVS_HOME_NOT_CONFIGURED' }
$llvsHome = [IO.Path]::GetFullPath($llvsHome)
$inbox = [IO.Path]::GetFullPath((Join-Path $llvsHome 'visual/feedback/inbox'))
if (-not $inbox.StartsWith($llvsHome + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'LLVS_FEEDBACK_PATH_INVALID' }
New-Item -ItemType Directory -Force -Path $inbox | Out-Null
$redact = { param($value) $value -replace '(?i)(token|secret|password|api[_-]?key)\s*[:=]\s*\S+', '$1=[REDACTED]' -replace 'gh[opsu]_[A-Za-z0-9_]+', '[REDACTED_GITHUB_TOKEN]' }
$record = [ordered]@{
    schemaVersion = 1
    id = 'LLVS-FEEDBACK-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceProject = & $redact $SourceProject
    command = & $redact $Command
    summary = & $redact $Summary
    detail = & $redact $Detail
    status = 'NEW'
}
$path = Join-Path $inbox ($record.id + '.json')
[IO.File]::WriteAllText($path, ($record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$result = [ordered]@{ localRecord = $path; githubIssue = $null }
$feedbackRepo = git config --global --get llvs.feedbackRepo 2>$null
if (-not $LocalOnly -and $feedbackRepo -and (Get-Command gh -ErrorAction SilentlyContinue)) {
    $body = "Source project: $($record.sourceProject)`n`nCommand: ``$($record.command)```n`n$($record.detail)`n`nLocal feedback ID: ``$($record.id)``"
    $bodyPath = Join-Path $env:TEMP ($record.id + '.md')
    try {
        [IO.File]::WriteAllText($bodyPath, $body, [Text.UTF8Encoding]::new($false))
        $issue = gh issue create --repo $feedbackRepo --title "[LLVS feedback] $($record.summary)" --body-file $bodyPath 2>$null
        if ($LASTEXITCODE -eq 0) { $result.githubIssue = $issue.Trim() }
    } finally {
        Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
    }
}
$result | ConvertTo-Json
