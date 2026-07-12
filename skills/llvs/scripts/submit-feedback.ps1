[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceProject,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$Summary,
    [AllowEmptyString()][string]$Detail = '',
    [string]$ErrorCode = 'UNSPECIFIED_FAILURE',
    [string]$FeedbackRepo = '',
    [switch]$Publish,
    [switch]$AllowPublic,
    [switch]$LocalOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}
Import-Module (Join-Path $PSScriptRoot 'feedback-core.psm1') -Force

if ($Publish -and $LocalOnly) { throw 'LLVS_FEEDBACK_MODE_CONFLICT' }
if ($AllowPublic -and -not $Publish) { throw 'LLVS_ALLOW_PUBLIC_REQUIRES_PUBLISH' }

$llvsHome = $env:LLVS_HOME
if (-not $llvsHome -and (Get-Command git -ErrorAction SilentlyContinue)) {
    $llvsHome = git config --global --get llvs.home 2>$null
}
if (-not $llvsHome) {
    $candidateRoot = (Get-Location).Path
    $candidateScript = Join-Path $candidateRoot 'visual.ps1'
    $candidateRegistry = Join-Path $candidateRoot 'visual/products/registry.json'
    if ((Test-Path -LiteralPath $candidateScript) -and (Test-Path -LiteralPath $candidateRegistry)) {
        $llvsHome = $candidateRoot
    }
}
if (-not $llvsHome) { throw 'LLVS_HOME_NOT_CONFIGURED' }

$llvsHome = Resolve-LLVSHomePath -Path $llvsHome
$inbox = [IO.Path]::GetFullPath((Join-Path $llvsHome 'visual/feedback/inbox'))
if (-not (Test-LLVSChildPath -Root $llvsHome -Candidate $inbox)) { throw 'LLVS_FEEDBACK_PATH_INVALID' }
New-Item -ItemType Directory -Force -Path $inbox | Out-Null

$feedbackId = 'LLVS-FEEDBACK-' + [guid]::NewGuid().ToString('N')
$record = [ordered]@{
    schemaVersion = 1
    id = $feedbackId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceProject = ConvertTo-LLVSRedactedText -Value $SourceProject
    command = ConvertTo-LLVSRedactedText -Value $Command
    summary = ConvertTo-LLVSRedactedText -Value $Summary
    detail = ConvertTo-LLVSRedactedText -Value $Detail
    errorCode = ConvertTo-LLVSSafeIdentifier -Value $ErrorCode -Fallback 'UNSPECIFIED_FAILURE' -MaximumLength 64 -Uppercase
    status = 'NEW'
}
$path = Join-Path $inbox ($record.id + '.json')
Write-LLVSJsonFileNoClobber -Path $path -Json ($record | ConvertTo-Json -Depth 6)

$publicPayload = New-LLVSPublicFeedbackPayload -FeedbackId $feedbackId -SourceProject $SourceProject -Command $Command -ErrorCode $ErrorCode
$result = [ordered]@{
    schemaVersion = 1
    localRecord = $path
    localWriteStatus = 'succeeded'
    publishRequested = [bool]$Publish
    publishStatus = if ($Publish) { 'pending' } else { 'not-requested' }
    publishErrorCode = $null
    githubIssue = $null
    publicPreview = $publicPayload
}

if ($Publish) {
    if (-not $FeedbackRepo -and (Get-Command git -ErrorAction SilentlyContinue)) {
        $FeedbackRepo = git config --global --get llvs.feedbackRepo 2>$null
    }

    if ([string]::IsNullOrWhiteSpace($FeedbackRepo)) {
        $result.publishStatus = 'failed'
        $result.publishErrorCode = 'FEEDBACK_REPO_NOT_CONFIGURED'
    } elseif ($FeedbackRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
        $result.publishStatus = 'failed'
        $result.publishErrorCode = 'INVALID_FEEDBACK_REPO'
    } elseif (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        $result.publishStatus = 'failed'
        $result.publishErrorCode = 'GH_NOT_INSTALLED'
    } else {
        $null = & gh auth status 2>&1
        if ($LASTEXITCODE -ne 0) {
            $result.publishStatus = 'failed'
            $result.publishErrorCode = 'GH_NOT_AUTHENTICATED'
        } else {
            $repoInfoRaw = & gh repo view $FeedbackRepo --json nameWithOwner,visibility,isPrivate 2>&1
            $repoInfoExitCode = $LASTEXITCODE
            if ($repoInfoExitCode -ne 0) {
                $result.publishStatus = 'failed'
                $result.publishErrorCode = 'FEEDBACK_REPO_UNAVAILABLE'
            } else {
                try {
                    $repoInfo = ($repoInfoRaw -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
                } catch {
                    $repoInfo = $null
                    $result.publishStatus = 'failed'
                    $result.publishErrorCode = 'FEEDBACK_REPO_RESPONSE_INVALID'
                }

                if ($null -ne $repoInfo -and $repoInfo.isPrivate -eq $false -and -not $AllowPublic) {
                    $result.publishStatus = 'failed'
                    $result.publishErrorCode = 'PUBLIC_REPO_CONFIRMATION_REQUIRED'
                } elseif ($null -ne $repoInfo) {
                    $body = ConvertTo-LLVSPublicIssueBody -Payload $publicPayload
                    $bodyPath = Join-Path ([IO.Path]::GetTempPath()) ($feedbackId + '.md')
                    try {
                        [IO.File]::WriteAllText($bodyPath, $body, [Text.UTF8Encoding]::new($false))
                        $issueOutput = & gh issue create --repo $repoInfo.nameWithOwner --title "[LLVS feedback] $($publicPayload.errorCode) ($($publicPayload.command))" --body-file $bodyPath 2>&1
                        if ($LASTEXITCODE -eq 0) {
                            $result.githubIssue = ($issueOutput -join [Environment]::NewLine).Trim()
                            $result.publishStatus = 'succeeded'
                        } else {
                            $result.publishStatus = 'failed'
                            $result.publishErrorCode = 'GH_ISSUE_CREATE_FAILED'
                        }
                    } finally {
                        Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        }
    }
}

$result | ConvertTo-Json -Depth 6
if ($Publish -and $result.publishStatus -ne 'succeeded') { exit 2 }
