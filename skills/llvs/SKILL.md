---
name: llvs
description: Run and maintain Loop Local Visual Studio workflows in any Codex project. Use when a project needs local-first visual design build, four-viewport export, Storybook/Playwright QA, visual comparison, recovery without Figma, product registration, or when an LLVS command fails and the failure should be reported back to the central LLVS repository.
---

# LLVS

Use the smallest project-local adapter around the central LLVS workflow. Keep product aesthetics, assets, North Stars and approvals owned by the consuming project.

## Locate LLVS

Resolve the central repository in this order:

1. `LLVS_HOME` environment variable.
2. `git config --global llvs.home`.
3. Current repository when `visual.ps1` and `visual/products/registry.json` exist.

Stop with `LLVS_HOME_NOT_CONFIGURED` if none resolves. Never guess another user's path.

## Workflow

1. Read the consuming project's `AGENTS.md` and visual specifications.
2. Run `<LLVS_HOME>/visual.ps1 doctor`.
3. Register project-specific sources without copying their aesthetic rules into LLVS core.
4. Run the needed command: `build`, `export`, `capture`, `compare`, `test`, `report`, `restore`, `degraded`, or `gate`.
5. Treat `NEEDS_REVIEW` and missing owner approval as deliberate human gates.
6. Never modify original Figma files, global third-party packages, credentials, or owner decisions.

## Failure feedback

When an LLVS command or compatibility path fails:

1. Reproduce once with the smallest relevant command.
2. Run `scripts/submit-feedback.ps1` with the source project, command, summary and sanitized detail.
3. Report the created feedback JSON path.
4. Continue locally when a safe workaround exists; do not silently weaken gates.

The feedback script writes only to `<LLVS_HOME>/visual/feedback/inbox/`. It redacts common secrets and does not commit, push, publish, or open a GitHub issue automatically.

## Public/open-source boundary

- Treat LLVS core code and generic fixtures separately from consuming-project assets.
- Do not copy private screenshots, fonts, Figma files, customer data or unverified third-party images into the central/public repository.
- Record only minimal reproduction metadata in feedback.
- Keep product aesthetics and asset licenses in the consuming project.
