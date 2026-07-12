# Loop Local Visual Studio

Loop Local Visual Studio (LLVS) is a local-first visual engineering workflow for Codex projects. It coordinates project-owned design sources, OpenPencil, Storybook, Playwright, visual evidence, recovery and owner gates without making Figma paid automation a core dependency.

This public repository starts with the reusable Codex skill and its sanitized cross-project feedback collector. The private ThreadsOfJianghu pilot proved the workflow but its images, screenshots, design documents and aesthetic decisions are intentionally excluded from this repository.

## Install the Codex skill

Copy `skills/llvs` to `$CODEX_HOME/skills/llvs`, then configure the local LLVS checkout used for feedback:

```powershell
git config --global llvs.home "C:\path\to\your\llvs-checkout"
```

Invoke it with:

```text
$llvs run visual restore for this project
```

## Maintenance feedback

When an LLVS workflow fails in another Codex project, the skill writes a sanitized JSON record to `visual/feedback/inbox/` in the configured LLVS checkout. It does not automatically publish private logs, create commits, push, or open GitHub issues.

## Open-source boundary

- LLVS-owned source code is MIT licensed.
- Dependencies retain their upstream licenses; see `THIRD_PARTY_NOTICES.md`.
- Consuming-project assets, fonts, screenshots, design files, North Stars and aesthetics remain owned and licensed by those projects.
- Do not submit credentials, customer data, private absolute paths or unverified third-party artwork in feedback.

## Current public scope

The initial public release is the reusable skill and maintenance boundary. Generic runtime modules will be migrated only after their fixtures and provenance can be published without carrying private pilot assets or history.
