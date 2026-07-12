---
name: llvs
description: Diagnose and maintain the public-preview Loop Local Visual Studio core in Codex projects. Use when a project needs LLVS installation checks, machine-readable capability discovery, local privacy-safe failure feedback, or explicitly authorized allowlisted GitHub feedback. Check capabilities before acting; build, capture, compare, restore, gate, OpenPencil, Storybook, Playwright and Godot adapters remain unavailable until the runtime reports them as implemented.
---

# LLVS

Use the smallest project-local adapter around the central LLVS workflow. Keep product aesthetics, assets, North Stars and approvals owned by the consuming project.

## Locate LLVS

Resolve the central repository in this order:

1. `LLVS_HOME` environment variable.
2. `git config --global llvs.home`.
3. Current repository only when both `visual.ps1` and `visual/products/registry.json` exist.

Stop with `LLVS_HOME_NOT_CONFIGURED` if none resolves. Never guess another user's path.

## Diagnose before acting

1. Read the consuming project's `AGENTS.md` and visual specifications.
2. Run `pwsh -File <LLVS_HOME>/visual.ps1 doctor -Json`.
3. Stop and report required failed checks when status is `NEEDS_FIX`.
4. Run `pwsh -File <LLVS_HOME>/visual.ps1 capabilities -Json`.
5. Invoke only capabilities listed under `implemented`.
6. Report `LLVS_CAPABILITY_NOT_IMPLEMENTED` for planned or unknown capabilities. Never simulate a successful build, capture, comparison, restore or gate.

## Record failure feedback

Run `<SKILL_ROOT>/scripts/submit-feedback.ps1` with source project, command, summary, detail and a stable error code. The default action writes only a local redacted record under `<LLVS_HOME>/visual/feedback/inbox/`.

Never publish merely because `llvs.feedbackRepo` is configured. Use `-Publish` only when the user explicitly asks to send feedback externally. Before targeting a public repository, show that only `publicPreview` fields will be sent and require explicit authorization to add `-AllowPublic`.

If publishing is requested and fails, preserve the local record, report `publishErrorCode`, and do not present the operation as successful.

## Public/open-source boundary

- Treat LLVS core code and generic fixtures separately from consuming-project assets.
- Keep raw paths, summaries, detail, command output, screenshots, fonts, Figma files, customer data and unverified artwork local.
- Publish only fields allowed by `visual/schemas/public-feedback.schema.json`.
- Keep product aesthetics and asset licenses in the consuming project.
