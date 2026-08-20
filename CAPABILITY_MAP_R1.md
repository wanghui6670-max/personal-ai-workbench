# Capability Map: Personal AI Workbench R1

Status: approved for implementation on 2026-08-20 by the user's instruction to proceed from the reviewed handoff plan.

| Module id | Responsibility | Depends on |
|---|---|---|
| `release-contract` | Fix the R1 target, non-goals, authority order, and release evidence | — |
| `reproducible-runtime` | Reproducible install, immutable runtime identity, one process, one `DATA_DIR`, safe LaunchAgent cutover | `release-contract` |
| `personal-core` | Capture, Inbox, review/clarification, Todo, Today, restart recovery, and truthful batch outcomes | `reproducible-runtime` |
| `external-safety` | Atomic Provider profiles, actual-model receipts, Feishu idempotency/redaction, and bounded DSH/Joycrew egress | `reproducible-runtime` |
| `operations` | Dependency diagnostics, structured operational receipts, backup/restore, fault injection, and rollback | `personal-core`, `external-safety` |
| `field-acceptance` | Real non-production canaries, browser/iPhone flow, restart recovery, and the 72-hour-or-longer pilot | `operations` |

Build order:

```text
release-contract
→ reproducible-runtime
→ personal-core + external-safety
→ operations
→ field-acceptance
```

`personal-core` and `external-safety` may proceed in parallel after the runtime identity contract is stable. R1 is not complete until `field-acceptance` has current-machine evidence; green unit tests alone are insufficient.

Module specs:

- `reproducible-runtime`: [`SPEC-reproducible-runtime.md`](SPEC-reproducible-runtime.md)
