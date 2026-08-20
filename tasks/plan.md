# R1 Implementation Plan

Authority: `docs/RELEASE_R1_CONTRACT.md` and `CAPABILITY_MAP_R1.md`.

## Phase 1 — Release contract and reproducible runtime

1. Commit the R1 target, requirement IDs, authority order, and non-goals.
2. Correct README/deployment/doctor language that still conflicts with the v3 source contract.
3. Add a root lockfile and verify clean `npm ci` on Node 24.
4. Add immutable runtime identity: full Git SHA, build timestamp, and static asset manifest/hash.
5. Make service status and browser boot fail closed on runtime/artifact mismatch.
6. Repair the P0 host gate so it consumes structured diagnostics rather than localized output text.

Checkpoint: a fresh isolated service can prove exactly which source and static assets it is serving. Do not switch the real LaunchAgent yet.

## Phase 2 — Personal core and single-writer safety

1. Add an exclusive process lock for the configured `DATA_DIR`.
2. Complete the no-AI/no-Feishu manual Inbox path.
3. Make batch APIs and UI report per-item success, failure, and skipped outcomes truthfully.
4. Verify Capture → Inbox → Todo → Today and restart recovery end to end.

Checkpoint: the core personal loop works offline and survives restart without duplicate or lost state.

## Phase 3 — External safety and execution receipts

1. Resolve each AI/Harness Provider as one atomic profile.
2. Reuse one endpoint security validator across Provider paths.
3. Persist and expose `provider_receipt_v1` without secrets or raw private content.
4. Move Feishu payloads out of argv; add safe error normalization.
5. Add stable operation intents and unknown-outcome reconciliation to all Feishu writes.
6. Add field-level egress contracts and receipts for DSH/Joycrew tools.

Checkpoint: synthetic secret/PII canaries have zero log, argv, error-response, and forbidden-egress hits; retry injection produces one remote write.

## Phase 4 — Operations and recovery

1. Separate core readiness from dependency diagnostics.
2. Add structured operational events, bounded retention, and actionable warnings.
3. Define the complete local asset inventory and backup manifest.
4. Add maintenance locking, retention verification, and empty-directory restore drills.
5. Add dynamic fault injection for cutover, rollback, state writes, external unknown outcomes, and disk/response limits.

Checkpoint: an empty-directory restore and failed-upgrade rollback both meet recorded RPO/RTO.

## Phase 5 — Current-machine acceptance and pilot

1. Install the exact candidate through the controlled LaunchAgent cutover.
2. Run non-production canaries for each enabled external integration.
3. Run the complete browser personal flow plus restart recovery. iPhone is tested only under a separately approved private-mobile profile.
4. Run a minimum 72-hour pilot, preferably 5–7 working days.
5. Produce a requirement-by-requirement release report and rollback decision.

Checkpoint: every `R1-*` requirement has current, authoritative evidence. Missing or indirect evidence is a release failure.

## Main risks and mitigations

| Risk | Mitigation |
|---|---|
| Passing tests hide an old live process | Runtime identity is returned by the process and compared with the artifact and installer manifest |
| External write succeeds but response is lost | Persist intent first; reconcile by operationId before retry |
| Local JSON is opened by two writers | Exclusive `DATA_DIR` lock; R1 forbids multiple instances |
| Provider/model falls back silently | Persist actual receipt and show degraded/fallback explicitly |
| Optional integration blocks daily use | Separate dependency diagnostics from core readiness and preserve manual flow |
| A broad rewrite delays a usable release | Keep the R1 single-machine architecture and ship in verified vertical slices |
