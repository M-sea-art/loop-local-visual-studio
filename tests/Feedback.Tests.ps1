BeforeAll {
    $repoRoot = Split-Path $PSScriptRoot -Parent
    $modulePath = Join-Path $repoRoot 'skills/llvs/scripts/feedback-core.psm1'
    $submitScript = Join-Path $repoRoot 'skills/llvs/scripts/submit-feedback.ps1'
    Import-Module $modulePath -Force
}

Describe 'LLVS feedback redaction' {
    It 'redacts representative secrets, identities and private paths' {
        $cases = @(
            @{ Value = 'C:\Users\Alice\private-client\game'; Forbidden = 'Alice' }
            @{ Value = 'Authorization: Bearer ' + ('sk-' + 'live-SECRET'); Forbidden = 'sk-live-SECRET' }
            @{ Value = 'github_' + 'pat_11AA_secretvalue'; Forbidden = 'github_pat_' }
            @{ Value = 'gh' + 'r_refreshsecret'; Forbidden = 'ghr_' }
            @{ Value = 'AWS_ACCESS_KEY_ID=' + ('AKIA' + '1234567890ABCDEF'); Forbidden = ('AKIA' + '1234567890ABCDEF') }
            @{ Value = 'password = "two words secret"'; Forbidden = 'two words secret' }
            @{ Value = 'api key: supersecret'; Forbidden = 'supersecret' }
            @{ Value = 'token=first second'; Forbidden = 'first second' }
            @{ Value = 'https://user:password@example.com/private'; Forbidden = 'user:password' }
            @{ Value = 'owner@example.com'; Forbidden = 'owner@example.com' }
        )

        foreach ($case in $cases) {
            (ConvertTo-LLVSRedactedText -Value $case.Value) | Should -Not -Match ([regex]::Escape($case.Forbidden))
        }
    }

    It 'normalizes LLVS_HOME with a trailing separator and accepts its inbox' {
        $root = Join-Path $TestDrive 'llvs-root'
        New-Item -ItemType Directory -Path $root | Out-Null
        $withTrailingSeparator = $root + [IO.Path]::DirectorySeparatorChar
        $normalized = Resolve-LLVSHomePath -Path $withTrailingSeparator
        $candidate = Join-Path $normalized 'visual/feedback/inbox'

        $normalized | Should -Be (Resolve-LLVSHomePath -Path $root)
        (Test-LLVSChildPath -Root $withTrailingSeparator -Candidate $candidate) | Should -BeTrue
    }

    It 'builds a public payload without raw project, summary or detail' {
        $payload = New-LLVSPublicFeedbackPayload `
            -FeedbackId 'LLVS-FEEDBACK-0123456789abcdef0123456789abcdef' `
            -SourceProject 'C:\Users\Alice\private-client\game' `
            -Command 'doctor --verbose' `
            -ErrorCode 'registry invalid'
        $json = $payload | ConvertTo-Json -Depth 4

        $json | Should -Not -Match 'Alice|private-client|Summary|Detail'
        $payload.projectRef | Should -Match '^project-[a-f0-9]{12}$'
        $payload.command | Should -Be 'doctor-verbose'
        $payload.errorCode | Should -Be 'REGISTRY-INVALID'
    }
}

Describe 'submit-feedback.ps1 local-first behavior' {
    It 'writes a redacted local record and does not request publication by default' {
        $root = Join-Path $TestDrive 'feedback-home'
        New-Item -ItemType Directory -Path $root | Out-Null
        $previousHome = $env:LLVS_HOME
        try {
            $env:LLVS_HOME = $root + [IO.Path]::DirectorySeparatorChar
            $output = & $submitScript `
                -SourceProject 'C:\Users\Alice\private-client\game' `
                -Command 'doctor' `
                -Summary 'Bearer token failed' `
                -Detail ('Authorization: Bearer ' + ('sk-' + 'live-SECRET')) `
                -ErrorCode 'AUTH_FAILED'
            $result = ($output | Out-String) | ConvertFrom-Json
            $record = Get-Content -LiteralPath $result.localRecord -Raw | ConvertFrom-Json

            $result.localWriteStatus | Should -Be 'succeeded'
            $result.publishRequested | Should -BeFalse
            $result.publishStatus | Should -Be 'not-requested'
            $record.id | Should -Match '^LLVS-FEEDBACK-[a-f0-9]{32}$'
            $record.sourceProject | Should -Not -Match 'Alice'
            $record.detail | Should -Not -Match 'sk-live-SECRET'
        } finally {
            $env:LLVS_HOME = $previousHome
        }
    }

    It 'uses collision-resistant feedback IDs' {
        $root = Join-Path $TestDrive 'unique-home'
        New-Item -ItemType Directory -Path $root | Out-Null
        $previousHome = $env:LLVS_HOME
        try {
            $env:LLVS_HOME = $root
            $first = (& $submitScript -SourceProject 'demo' -Command 'doctor' -Summary 'one' | Out-String) | ConvertFrom-Json
            $second = (& $submitScript -SourceProject 'demo' -Command 'doctor' -Summary 'two' | Out-String) | ConvertFrom-Json

            $first.localRecord | Should -Not -Be $second.localRecord
            (Test-Path -LiteralPath $first.localRecord) | Should -BeTrue
            (Test-Path -LiteralPath $second.localRecord) | Should -BeTrue
        } finally {
            $env:LLVS_HOME = $previousHome
        }
    }
}
