# Loop Local Visual Studio

Loop Local Visual Studio (LLVS) is a local-first visual engineering workflow for Codex projects. The public repository is currently a **public preview of the LLVS core contract**: installation diagnostics, machine-readable capability discovery, a reusable Codex skill and privacy-safe local failure feedback.

The private ThreadsOfJianghu pilot proved a broader workflow, but its images, screenshots, design documents and aesthetic decisions are intentionally excluded. Generic OpenPencil, Storybook, Playwright, comparison, recovery and Godot adapters will move here only with synthetic fixtures and reproducible tests.

## Current status

Implemented now:

- `visual.ps1 doctor`
- `visual.ps1 capabilities`
- versioned product registry and feedback schemas
- local redacted JSON feedback
- explicit, allowlisted GitHub feedback publishing

Not implemented in this public preview: `build`, `export`, `capture`, `compare`, `test`, `report`, `restore`, `degraded`, `gate` and Godot conversion. Check `visual/capabilities.json` instead of assuming a command exists.

## Quick start

Clone the repository and verify its public core:

```powershell
pwsh -File .\visual.ps1 doctor -Json
pwsh -File .\visual.ps1 capabilities -Json
```

A healthy checkout reports `READY_CORE`. Optional tools such as GitHub CLI, Node and OpenPencil may still report missing because they are not required for the current public core.

## Install the Codex skill

Copy `skills/llvs` to `$CODEX_HOME/skills/llvs`, then point the skill to this checkout:

```powershell
git config --global llvs.home "C:\path\to\your\llvs-checkout"
```

Invoke it with:

```text
$llvs diagnose this visual workflow
```

The skill runs `doctor` and reads `capabilities` before attempting work. It must not claim or simulate a planned capability.

## Failure feedback

Feedback is local by default:

```powershell
pwsh -File .\skills\llvs\scripts\submit-feedback.ps1 `
  -SourceProject "C:\work\my-project" `
  -Command "doctor" `
  -Summary "Registry validation failed" `
  -Detail "Sanitized local context" `
  -ErrorCode "REGISTRY_INVALID"
```

The command writes a JSON record under `visual/feedback/inbox/` and returns a `publicPreview`. No external Issue is created merely because a repository is configured.

To prepare GitHub feedback, configure the target and explicitly request publishing:

```powershell
git config --global llvs.feedbackRepo "M-sea-art/loop-local-visual-studio"

pwsh -File .\skills\llvs\scripts\submit-feedback.ps1 `
  -SourceProject "C:\work\my-project" `
  -Command "doctor" `
  -Summary "Registry validation failed" `
  -ErrorCode "REGISTRY_INVALID" `
  -Publish `
  -AllowPublic
```

`-Publish` is always explicit. A public target also requires `-AllowPublic`. Only the fields defined in `visual/schemas/public-feedback.schema.json` are uploaded; raw paths, summaries, detail and command output remain local. Authentication, repository lookup and Issue creation failures return structured error codes and a non-zero exit code.

## Open-source boundary

- LLVS-owned source code is MIT licensed.
- Dependencies retain their upstream licenses; see `THIRD_PARTY_NOTICES.md`.
- Consuming-project assets, fonts, screenshots, design files, North Stars and aesthetics remain owned and licensed by those projects.
- Never submit credentials, customer data, private paths, screenshots or unverified third-party artwork in feedback.

## Repository layout

```text
visual.ps1                         public doctor and capability entrypoint
visual/capabilities.json           implemented/planned contract
visual/products/registry.json      project registration contract
visual/schemas/                    versioned JSON schemas
skills/llvs/                       reusable Codex skill
tests/                             PowerShell and contract tests
```
