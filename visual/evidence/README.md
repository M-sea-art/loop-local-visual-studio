# LLVS Evidence Runtime

The evidence runtime defines the contract between AI agents and visual verification.

An agent should not claim completion without producing inspectable evidence.

## Evidence flow

```
Implementation
    ↓
Evidence producer
    ↓
VisualEvidence
    ↓
Validator
    ↓
Quality Gate
```

## Principles

- Evidence before confidence.
- Missing evidence is not success.
- Producers may be replaced; the evidence contract remains stable.

Future producers:

- Playwright
- OpenPencil
- Storybook
- Godot
