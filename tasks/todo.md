# R1 Task List

Tasks are dependency ordered. A checked box requires the listed verification evidence, not only code presence.

- [x] Task R1-001: Fix the R1 release target and capability map.
  - Acceptance: target, non-goals, requirement IDs, dependencies, release gates, and authority order are explicit.
  - Verify: read `CAPABILITY_MAP_R1.md`, `docs/RELEASE_R1_CONTRACT.md`, and `tasks/plan.md`.
  - Files: `CAPABILITY_MAP_R1.md`, `docs/RELEASE_R1_CONTRACT.md`, `tasks/plan.md`, `tasks/todo.md`.

- [ ] Task R1-001B: Remove v2 source-contract drift from formal operations guidance.
  - Acceptance: README, deployment guidance, doctor, and P0 reports identify Feishu explicit todos as the personal-task source and GetNote only as a confirmed content source.
  - Verify: task-source documentation tests, doctor JSON contract tests, and a readback of the authoritative documentation tree.
  - Files: update documentation and diagnostics in <=5-file slices.

- [x] Task R1-002: Add a reproducible root install contract.
  - Acceptance: Node 24 can run `npm ci` from a clean dependency state without creating an untracked lockfile.
  - Verify: `npm ci --ignore-scripts --no-audit --no-fund && npm test`.
  - Files: `package.json`, `package-lock.json`, `.node-version`, one install-contract test if required.

- [ ] Task R1-002B: Make every automated build consume the pinned toolchain and root lockfile.
  - Acceptance: CI uses `.node-version` plus root `npm ci`; browser smoke has no temporary dependency install; Docker uses an exact Node patch and both lockfiles.
  - Verify: workflow contract tests, root/Harness clean installs, browser smoke, and Docker build.
  - Files: workflow files in one slice; Dockerfile and its focused test in a separate slice.

- [ ] Task R1-003: Define and expose immutable runtime identity.
  - Acceptance: health exposes full source SHA, build timestamp, and deterministic public asset manifest hash without reading Git on each request.
  - Verify: focused runtime-identity test plus isolated service health readback.
  - Files: runtime identity module, `src/health.mjs`, `src/server.mjs`, focused test.

- [ ] Task R1-004: Fail closed on live/artifact version mismatch.
  - Acceptance: macOS status, post-install verification, and browser startup detect mismatched source or static assets and stop business actions.
  - Verify: mismatch unit tests, browser smoke, isolated LaunchAgent fixture test.
  - Files: `scripts/macos-launch-agent.mjs`, browser bootstrap module, related tests.

- [ ] Task R1-005: Replace localized P0 doctor parsing with a structured contract.
  - Acceptance: host preflight is independent of Chinese/English presentation text and reports per-dependency state.
  - Verify: `node --test tests/doctor.test.mjs tests/host-p0.test.mjs`.
  - Files: `scripts/doctor.mjs`, `scripts/p0-host-preflight.mjs`, two focused tests.

- [ ] Task R1-006: Enforce one writer per `DATA_DIR`.
  - Acceptance: a second process against the same directory fails before serving or mutating state; stale lock recovery is bounded and auditable.
  - Verify: concurrent-process integration test and restart recovery test.
  - Files: lock module, `src/server.mjs`, focused test, deployment documentation.

- [ ] Task R1-007: Complete the offline manual personal flow.
  - Acceptance: Capture/Inbox can be clarified or converted to Todo and Today with AI, Feishu, DSH, and Joycrew disabled.
  - Verify: domain integration test and browser E2E across restart.
  - Files: only the affected domain/API/UI modules and focused tests, split into <=5-file slices.

- [ ] Task R1-008: Make batch outcomes truthful.
  - Acceptance: partial failure never renders as total success; every selected item has a terminal result.
  - Verify: injected partial-failure domain and UI tests.
  - Files: batch domain, batch UI, focused tests.

- [ ] Task R1-009: Make Provider profiles atomic and share endpoint validation.
  - Acceptance: model, credential, API style, base URL, and network zone cannot be composed across profile families; private/reserved endpoints fail closed.
  - Verify: mixed-profile and IPv4/IPv6/redirect/DNS safety tests.
  - Files: Provider config/validator, Harness resolver, focused tests.

- [ ] Task R1-010: Add `provider_receipt_v1`.
  - Acceptance: requested/actual provider and model, requestId, usage, latency, fallback, degraded, and workflow are persisted or explicitly `unverified`.
  - Verify: adapter tests, API readback, real non-production canary later in R1-018.
  - Files: AI execution layer, persistence/API projection, focused tests.

- [ ] Task R1-011: Secure and reconcile Feishu writes.
  - Acceptance: 正文不进入 argv/log/API error；稳定 operationId 支持 unknown-outcome 查重和唯一提交。
  - Verify: process-list/log canary and remote-success/local-timeout injection tests.
  - Files: one adapter/operation flow at a time with its focused tests.

- [ ] Task R1-012: Add DSH/Joycrew field-level egress contracts.
  - Acceptance: each tool has allowed/forbidden fields, row/size bounds, redaction, purpose, and an egress receipt.
  - Verify: synthetic PII canary tests and policy-denial tests.
  - Files: Harness policy/broker, Joycrew projection, focused tests.

- [ ] Task R1-013: Separate readiness and dependency diagnostics.
  - Acceptance: core health stays fast and local; each optional dependency exposes last check, last success, latency, safe error code, and enabled/configured/available state.
  - Verify: dependency timeout tests and diagnostics API readback.
  - Files: health/diagnostics modules, server route, focused tests.

- [ ] Task R1-014: Add bounded structured operational events.
  - Acceptance: requestId, operationId, stage, duration, result, and safe error code are queryable without raw private content or credentials.
  - Verify: synthetic secret canary has zero hits; retention bound test passes.
  - Files: event module, server integration, focused tests.

- [ ] Task R1-015: Expand and verify the recovery contract.
  - Acceptance: the backup manifest covers all local R1 state and receipts, explicitly references external/recover-separately assets, and restoration is maintenance-locked.
  - Verify: empty-directory restore, corrupted-input rollback, and RPO/RTO report.
  - Files: backup/restore modules, scripts, focused tests, deployment documentation.

- [ ] Task R1-016: Add dynamic deployment and durability fault injection.
  - Acceptance: plist lint, port release, bootstrap, health, version mismatch, rollback, interrupted write, corrupt JSON, and unknown external outcome failures have verified behavior.
  - Verify: fault-injection suite with artifact report.
  - Files: test fixtures/harness and the smallest production hooks needed.

- [ ] Task R1-017: Run the exact-candidate macOS cutover.
  - Acceptance: repository, installer, process, and static asset identities match after restart, with rollback evidence.
  - Verify: `npm run service:macos -- status`, health identity readback, browser smoke.
  - Files: no source changes; this is a controlled local deployment step requiring the production-change gate.

- [ ] Task R1-018: Run real non-production integration canaries.
  - Acceptance: Feishu and every other enabled GetNote/Provider/DSH path have one success and one recovery receipt using non-sensitive test data; iPhone is out of default R1 unless a private-mobile profile is separately approved.
  - Verify: read back actual remote/local effects and safe receipts; replay/mock results do not count.
  - Files: acceptance artifacts only; external writes require the task-specific confirmation gate.

- [ ] Task R1-019: Complete the R1 pilot and release audit.
  - Acceptance: at least 72 hours, preferably 5–7 working days, with no data loss, duplicate external write, unexplained fallback, or unrecovered interruption; every requirement has evidence.
  - Verify: pilot report, requirement matrix, rollback decision, and final service readback.
  - Files: release evidence and final report.
