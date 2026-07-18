BeforeAll {
    $repoRoot = Split-Path $PSScriptRoot -Parent
    $visualScript = Join-Path $repoRoot 'visual.ps1'
}

Describe 'LLVS public core' {
    It 'reports READY_CORE from doctor' {
        $result = (& $visualScript doctor -Json | Out-String) | ConvertFrom-Json
        $result.status | Should -Be 'READY_CORE'
        @($result.checks | Where-Object { $_.required -and -not $_.ok }).Count | Should -Be 0
    }

    It 'reports implemented and planned capabilities without overlap' {
        $result = (& $visualScript capabilities -Json | Out-String) | ConvertFrom-Json
        $implemented = @($result.implemented.name)

        $implemented | Should -Contain 'doctor'
        $implemented | Should -Contain 'feedback.local'
        $implemented | Should -Contain 'design-evidence.readonly'
        $result.planned | Should -Contain 'capture'
        @($result.planned | Where-Object { $implemented -contains $_ }).Count | Should -Be 0
    }

    It 'ships the deterministic design evidence contract' {
        Test-Path -LiteralPath (Join-Path $repoRoot 'visual/scripts/agent-design.mjs') | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $repoRoot 'visual/scripts/agent-design-cli.mjs') | Should -BeTrue
        Test-Path -LiteralPath (Join-Path $repoRoot 'visual/tests/agent-design.test.mjs') | Should -BeTrue
    }

    It 'keeps a versioned synthetic public product fixture' {
        $registryPath = Join-Path $repoRoot 'visual/products/registry.json'
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json

        $registry.schemaVersion | Should -Be 1
        @($registry.products).Count | Should -Be 1
        (Test-Path -LiteralPath (Join-Path $repoRoot $registry.products[0].root)) | Should -BeTrue
        (Test-Path -LiteralPath (Join-Path $repoRoot $registry.products[0].visualSpec)) | Should -BeTrue
    }
}
