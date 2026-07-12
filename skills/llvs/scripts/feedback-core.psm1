Set-StrictMode -Version Latest

function Get-LLVSPlatformName {
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Windows)) { return 'windows' }
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::OSX)) { return 'macos' }
    if ([Runtime.InteropServices.RuntimeInformation]::IsOSPlatform([Runtime.InteropServices.OSPlatform]::Linux)) { return 'linux' }
    return 'unknown'
}

function Resolve-LLVSHomePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { throw 'LLVS_HOME_NOT_CONFIGURED' }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath -ne $root) {
        $trimCharacters = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
        $fullPath = $fullPath.TrimEnd($trimCharacters)
    }
    return $fullPath
}

function Test-LLVSChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Candidate
    )

    $normalizedRoot = Resolve-LLVSHomePath -Path $Root
    $normalizedCandidate = [IO.Path]::GetFullPath($Candidate)
    $separator = [IO.Path]::DirectorySeparatorChar
    $rootPrefix = if ($normalizedRoot.EndsWith([string]$separator)) { $normalizedRoot } else { $normalizedRoot + $separator }
    $comparison = if ((Get-LLVSPlatformName) -eq 'windows') {
        [StringComparison]::OrdinalIgnoreCase
    } else {
        [StringComparison]::Ordinal
    }
    return $normalizedCandidate.StartsWith($rootPrefix, $comparison)
}

function ConvertTo-LLVSRedactedText {
    param([AllowNull()][AllowEmptyString()][string]$Value)

    if ($null -eq $Value) { return '' }
    $protected = [string]$Value
    $protected = [regex]::Replace($protected, '(?i)\b(authorization\s*:\s*(?:bearer|basic)\s+)\S+', '$1[REDACTED]')
    $protected = [regex]::Replace($protected, '(?i)\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{8,})\b', '[REDACTED_TOKEN]')
    $protected = [regex]::Replace($protected, '(?im)\b(token|secret|password|passwd|pwd|api[ _-]?key|access[ _-]?key|client[ _-]?secret)\b\s*[:=]\s*(?:"[^"\r\n]*"|''[^''\r\n]*''|[^\r\n;,]+)', '$1=[REDACTED]')
    $protected = [regex]::Replace($protected, '(?i)\b(https?://)[^/\s:@]+:[^/\s@]+@', '$1[REDACTED]@')
    $protected = [regex]::Replace($protected, '(?i)([?&](?:access_token|token|api_key|key)=)[^&#\s]+', '$1[REDACTED]')
    $protected = [regex]::Replace($protected, '(?i)([A-Z]:\\Users\\)[^\\\r\n]+', '$1[REDACTED]')
    $protected = [regex]::Replace($protected, '(?i)(/(?:home|Users)/)[^/\r\n]+', '$1[REDACTED]')
    $protected = [regex]::Replace($protected, '(?i)\\\\[^\\\s]+\\[^\\\s]+', '[REDACTED_UNC_PATH]')
    $protected = [regex]::Replace($protected, '(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', '[REDACTED_EMAIL]')
    return $protected
}

function Get-LLVSProjectReference {
    param([Parameter(Mandatory = $true)][string]$SourceProject)

    $normalized = $SourceProject.Trim().ToLowerInvariant()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
        $hash = $sha256.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
        return 'project-' + $hex.Substring(0, 12)
    } finally {
        $sha256.Dispose()
    }
}

function ConvertTo-LLVSSafeIdentifier {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Fallback,
        [ValidateRange(1, 128)][int]$MaximumLength = 64,
        [switch]$Uppercase
    )

    $safe = [regex]::Replace($Value, '[^A-Za-z0-9_.-]+', '-')
    $safe = [regex]::Replace($safe, '[-._]{2,}', '-')
    $safe = $safe.Trim([char[]]@('-', '.', '_'))
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = $Fallback }
    if ($safe.Length -gt $MaximumLength) { $safe = $safe.Substring(0, $MaximumLength) }
    if ($Uppercase) { $safe = $safe.ToUpperInvariant() } else { $safe = $safe.ToLowerInvariant() }
    return $safe
}

function New-LLVSPublicFeedbackPayload {
    param(
        [Parameter(Mandatory = $true)][string]$FeedbackId,
        [Parameter(Mandatory = $true)][string]$SourceProject,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string]$ErrorCode
    )

    $commandName = ($Command.Trim() -split '\s+')[0]
    return [ordered]@{
        schemaVersion = 1
        feedbackId = $FeedbackId
        projectRef = Get-LLVSProjectReference -SourceProject $SourceProject
        command = ConvertTo-LLVSSafeIdentifier -Value (ConvertTo-LLVSRedactedText -Value $commandName) -Fallback 'unknown-command' -MaximumLength 48
        errorCode = ConvertTo-LLVSSafeIdentifier -Value $ErrorCode -Fallback 'UNSPECIFIED_FAILURE' -MaximumLength 64 -Uppercase
        platform = Get-LLVSPlatformName
        powershellVersion = $PSVersionTable.PSVersion.ToString()
    }
}

function ConvertTo-LLVSPublicIssueBody {
    param([Parameter(Mandatory = $true)][System.Collections.IDictionary]$Payload)

    return @(
        'This issue contains allowlisted diagnostic metadata only.'
        ''
        "- Feedback ID: ``$($Payload.feedbackId)``"
        "- Project reference: ``$($Payload.projectRef)``"
        "- Command: ``$($Payload.command)``"
        "- Error code: ``$($Payload.errorCode)``"
        "- Platform: ``$($Payload.platform)``"
        "- PowerShell: ``$($Payload.powershellVersion)``"
        ''
        'Raw paths, summaries, command output and failure details remain local and were not uploaded.'
    ) -join [Environment]::NewLine
}

function Write-LLVSJsonFileNoClobber {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Json
    )

    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
        try {
            $writer.Write($Json)
            $writer.Flush()
        } finally {
            $writer.Dispose()
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

Export-ModuleMember -Function @(
    'Get-LLVSPlatformName',
    'Resolve-LLVSHomePath',
    'Test-LLVSChildPath',
    'ConvertTo-LLVSRedactedText',
    'Get-LLVSProjectReference',
    'ConvertTo-LLVSSafeIdentifier',
    'New-LLVSPublicFeedbackPayload',
    'ConvertTo-LLVSPublicIssueBody',
    'Write-LLVSJsonFileNoClobber'
)
