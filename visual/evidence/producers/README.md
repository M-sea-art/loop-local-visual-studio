# Evidence Producers

LLVS separates evidence generation from evidence validation.

A producer is any local capability that can observe a running product and emit a valid `VisualEvidence` object.

## Producer contract

```text
Producer
   |
   | collect()
   v
VisualEvidence
   |
   v
Validator
   |
   v
Quality Gate
```

## Planned producers

### Playwright

Browser-based evidence collection:

- viewport screenshots
- DOM snapshots
- interaction checks
- reproducible browser state

### Storybook

Component-level evidence:

- component states
- visual regression inputs
- design system validation

### OpenPencil

Design-source evidence:

- design metadata
- component relationships
- visual intent

### Godot

Game UI evidence:

- Control hierarchy
- runtime screenshots
- interaction states

## Design rule

LLVS does not care how evidence is produced.

It only accepts evidence that follows the stable contract.

This keeps the verification layer independent from individual tools.