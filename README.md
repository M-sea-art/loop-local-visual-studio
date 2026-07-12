# Loop Local Visual Studio

> **Experimental public preview / 早期公开测试版**

**Help Codex not only build interfaces, but actually inspect, test and improve them.**  
**让 Codex 不只会写界面，还能真正看见、检查并改好界面。**

Loop Local Visual Studio（**LLVS**）是一个面向 Codex 与其他 AI 编程 Agent 的本地优先视觉工程实验项目。

它不是一个已经完成的 Figma 替代品，也不是一个成熟的“一键生成界面”产品。这个仓库目前公开的是一套正在验证中的核心工作流：让 Agent 在宣告 UI 已完成之前，先发现本机可用工具、检查真实页面、收集视觉证据、暴露失败，并在能力不足时诚实降级。

LLVS is an experimental, local-first visual engineering workflow for Codex and other AI coding agents.

It is **not** a finished Figma replacement or a mature one-click UI generator. The repository currently exposes an early core workflow: before an agent claims that an interface is complete, it should discover available local tools, inspect the real result, collect evidence, report failures and degrade honestly when a capability is unavailable.

## Why this experiment exists / 为什么做这个实验

AI 编程 Agent 已经可以很快写出页面，但“代码能运行”并不代表“产品可以交付”。

很多明显的问题不会出现在编译错误里：

- 文字被裁切，但控制台没有报错；
- 按钮画出来了，却没有任何实际功能；
- 大屏看起来正常，小屏已经挤成一团；
- 自动化测试通过了，但页面仍然难以阅读或操作；
- 实现逐渐偏离设计目标，Agent 却仍然宣布任务完成。

LLVS 尝试把模糊的“帮我检查一下 UI”，变成一套可重复、可验证、可留下证据的本地工程流程。

AI coding agents can produce interfaces quickly, but code that runs is not necessarily a product that is ready to ship.

Many obvious failures never appear as compiler or console errors:

- text is clipped while automated checks stay green;
- a button exists but performs no useful action;
- the desktop view works while smaller viewports collapse;
- tests pass even though the interface is difficult to read or use;
- the implementation drifts away from the intended design while the agent still reports success.

LLVS explores how to turn the vague instruction “check the UI” into a repeatable local workflow with inspectable evidence.

## Current status / 当前状态

This repository intentionally ships early. It is a **test version for validating the core contract in real projects**, not a finished product.

这个仓库选择尽早公开。它目前是一个用于真实项目验证核心思路的**测试版**，不是完整产品。

### Implemented now / 当前已实现

- `visual.ps1 doctor`
  - Validates the LLVS public core, registry and optional local dependencies.
  - 检查 LLVS 核心、项目注册表以及可选本地依赖。
- `visual.ps1 capabilities`
  - Returns a machine-readable list of implemented and planned capabilities.
  - 返回机器可读的已实现与规划能力清单。
- Versioned product registry and JSON schemas.
  - 版本化的产品注册表与 JSON Schema。
- Reusable Codex skill.
  - 可复用的 Codex Skill。
- Local, redacted JSON failure feedback.
  - 默认保存在本机的脱敏 JSON 失败反馈。
- Explicit, allowlisted GitHub feedback publishing.
  - 只有在明确授权后才会发布的 GitHub 反馈。

### Planned, not implemented yet / 已规划但尚未实现

- project registration;
- build and export workflows;
- multi-viewport capture;
- visual comparison and regression checks;
- interaction testing;
- reports and quality gates;
- recovery and degraded-mode workflows;
- OpenPencil adapter;
- Storybook adapter;
- Playwright four-viewport evidence;
- Godot Control conversion.

Please inspect `visual/capabilities.json` instead of assuming that a planned command already exists.

请以 `visual/capabilities.json` 为准，不要把规划中的命令当成已经实现的功能。

## Intended direction / 目标方向

LLVS 不打算重造所有视觉工具。

它更像一个本地视觉工程控制层，把已有工具接到正确的位置：

```text
Product goal / North Star
        ↓
OpenPencil or another design source
        ↓
Frontend, Storybook or Godot implementation
        ↓
Playwright and real browser execution
        ↓
Multi-viewport screenshots and interaction evidence
        ↓
Visual comparison, UX review and issue diagnosis
        ↓
Codex repair
        ↓
Run again until the quality gate passes
```

LLVS does not aim to rebuild every visual tool.

The long-term idea is to act as a local visual-engineering control layer that connects existing tools, gathers real evidence and prevents an agent from treating “no error” as “ready to ship.”

## Quick start / 快速开始

Clone the repository and verify the current public core:

```powershell
pwsh -File .\visual.ps1 doctor -Json
pwsh -File .\visual.ps1 capabilities -Json
```

A healthy checkout reports `READY_CORE`.

Optional tools such as GitHub CLI, Node and OpenPencil may still report missing because they are not required for the current public core.

## Install the Codex skill / 安装 Codex Skill

Copy `skills/llvs` to `$CODEX_HOME/skills/llvs`, then point the skill to this checkout:

```powershell
git config --global llvs.home "C:\path\to\your\llvs-checkout"
```

Invoke it with:

```text
$llvs diagnose this visual workflow
```

The skill must run `doctor` and read `capabilities` before attempting work. It must not claim, simulate or silently substitute a planned capability.

## Failure feedback / 失败反馈

Feedback is local by default:

```powershell
pwsh -File .\skills\llvs\scripts\submit-feedback.ps1 `
  -SourceProject "C:\work\my-project" `
  -Command "doctor" `
  -Summary "Registry validation failed" `
  -Detail "Sanitized local context" `
  -ErrorCode "REGISTRY_INVALID"
```

The command writes a JSON record under `visual/feedback/inbox/` and returns a `publicPreview`.

No external Issue is created merely because a repository is configured.

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

`-Publish` is always explicit. A public target additionally requires `-AllowPublic`.

Only fields defined by `visual/schemas/public-feedback.schema.json` may be uploaded. Raw paths, detailed summaries, command output, screenshots and private project material remain local.

## Open-source boundary / 开源边界

- LLVS-owned source code is MIT licensed.
- Dependencies retain their upstream licenses; see `THIRD_PARTY_NOTICES.md`.
- Consuming-project assets, fonts, screenshots, design files, North Stars and aesthetic decisions remain owned and licensed by those projects.
- Never submit credentials, customer data, private paths, screenshots or unverified third-party artwork in feedback.

## Repository layout / 仓库结构

```text
visual.ps1                         public doctor and capability entrypoint
visual/capabilities.json           implemented/planned contract
visual/products/registry.json      project registration contract
visual/schemas/                    versioned JSON schemas
skills/llvs/                       reusable Codex skill
tests/                             PowerShell and contract tests
```

## Contributing during the preview / 参与测试

This preview is especially useful for finding where the workflow is incomplete, confusing or too optimistic.

欢迎提交：

- 安装或环境诊断失败；
- Windows 本地工具识别问题；
- 能力清单与实际行为不一致；
- 隐私边界或反馈流程问题；
- 可复现的 OpenPencil、Storybook、Playwright 或 Godot 适配需求。

Please avoid submitting private screenshots, credentials, customer data or proprietary project assets.

The project will grow through real failures, reproducible fixtures and honest capability reporting—not by pretending the test version is already complete.

这个项目会通过真实失败、可复现样例和诚实的能力声明逐步完善，而不是把测试版包装成已经完成的产品。
