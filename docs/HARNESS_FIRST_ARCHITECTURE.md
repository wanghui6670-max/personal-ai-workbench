# Harness-First Architecture

> Status: implementation baseline for `harness-first-rebuild`.
>
> Goal: make the Harness the platform owner. Personal AI Workbench becomes the first app running on it, not the owner of the runtime.

## 1. First-principles problem statement

The system is not fundamentally a task manager, chat UI, project tracker, or collection of integrations.

The irreducible problem is:

> An AI system must maintain durable work context, know which capabilities exist, decide which agent should act, call tools under explicit risk policy, resume work across time, and absorb new external capabilities without rewriting the platform.

Therefore the platform must own only capabilities that are universal across business domains:

1. append-only events and deterministic state reconstruction;
2. auditable traces without hidden reasoning;
3. capability and plugin discovery;
4. agent declarations;
5. durable sessions;
6. typed tools;
7. approval policy;
8. scheduling and dispatch;
9. app composition.

Inbox, Todo, Project, Feishu, Joycrew, GetNote and AIHot are **not** kernel concepts.

## 2. Layer model

```text
Apps
  Personal Workbench / future Business Cockpits
                    |
Skills / Methods / Workflows
                    |
Capabilities + Plugins + Agents + Views
                    |
Harness Runtime
  Agent / Session / Tool / Approval / Scheduler
                    |
Capability Registry / Plugin Loader
                    |
Kernel
  Event / State Projection / Trace / persistence primitives
                    |
Runtime Engine Adapter
  DeepSeek Harness today; replaceable later
```

### Kernel

The Kernel is deliberately business-blind.

Current implementation:

- `platform/kernel/event-store.mjs`
- `platform/kernel/state-projector.mjs`
- `platform/kernel/trace-store.mjs`

The Kernel must never import Workbench, Feishu, Joycrew, GetNote or AIHot modules.

### Harness Runtime

Current implementation:

- `platform/runtime/platform.mjs`
- `platform/runtime/agent-registry.mjs`
- `platform/runtime/session-manager.mjs`
- `platform/runtime/tool-broker.mjs`
- `platform/runtime/approval-engine.mjs`
- `platform/runtime/scheduler.mjs`
- `platform/runtime/plugin-loader.mjs`

### Registry

`platform/registry/capability-registry.mjs` is the source of truth for installed capabilities.

The runtime asks the Registry what is available. Agents declare capability IDs, not adapter imports.

## 3. Core contracts

### Plugin

A Plugin connects or packages an implementation surface.

A plugin manifest declares:

- stable ID;
- semantic version;
- adapter path;
- provided capabilities.

Secrets are not accepted inside manifests.

### Capability

A Capability is a semantic ability available to agents/apps.

Examples:

- `project`
- `inbox`
- `todo`
- `aihot`

A Capability may expose zero or more Tools.

### Agent

An Agent declares:

- identity;
- instructions;
- allowed capabilities.

The runtime derives its actual tool surface from installed capabilities. Agents do not import adapters directly.

### Session

A Session is durable work context, not merely a chat transcript.

The minimal contract stores:

- ID;
- scope;
- goal;
- context references;
- events;
- checkpoints.

Future persistent storage may replace the current in-memory adapter without changing the Session contract.

### Tool

A Tool is the smallest auditable action.

Every Tool must declare a risk class:

- `read`
- `local-write`
- `external-write`
- `destructive`

### Approval

Default policy:

| Risk | Mode |
| --- | --- |
| read | auto |
| local-write | auto |
| external-write | confirm |
| destructive | explicit |

Business-specific approval exceptions must be policy configuration, not ad-hoc UI checks.

### Scheduler

Scheduler owns time-triggered dispatch only. Business logic stays in Agents/Capabilities.

A scheduled job dispatches at least:

- Agent ID;
- Session ID;
- schedule metadata;
- trigger context.

## 4. Personal Workbench is an App

`apps/personal-workbench/manifest.mjs` declares the first app.

The App owns views and product composition, not platform runtime ownership.

This reverses the V3 ownership model:

```text
V3
Workbench -> Harness / Joycrew / Feishu / Project

Harness-first
Harness -> installed capabilities/plugins -> Personal Workbench App
```

The V3 UI and domain logic remain in place during migration so behavior can be proven equivalent before cutover.

## 5. V3 compatibility strategy

`plugins/workbench-v3-bridge/index.mjs` adapts the existing proven allow-listed Workbench Tools into Harness Capabilities.

This is intentionally a migration bridge, not the final architecture.

Rules:

1. do not copy mature domain rules;
2. resolve fresh Workbench context at execution time;
3. map V3 `readOnly` to `read` risk;
4. map confirmed V3 mutations to `local-write` during the compatibility phase;
5. split tools into semantic capabilities such as Project, Inbox and Todo;
6. replace the bridge incrementally with native capabilities only after parity tests exist.

## 6. DeepSeek Harness relationship

The repository already pins DeepSeek Harness as the current runtime engine.

DeepSeek Harness is an implementation dependency, not the product contract.

The platform must remain able to replace or upgrade the engine without migrating business state, plugins, capability manifests or app declarations.

Existing `harness/navigator.cordis.yml` and `harness/employee.cordis.yml` therefore become runtime compositions / agent profiles, not the definition of the whole product.

## 7. Proof-of-architecture: AIHot

`plugins/aihot/index.mjs` is the first external proof-of-architecture plugin.

Acceptance rule:

> Installing AIHot must require zero edits to Kernel, Harness Runtime or Capability Registry.

It exposes read-only information tools against a fixed provider origin. Agent arguments cannot supply arbitrary URLs.

If a future integration requires changing Core solely to accommodate its business semantics, the extension contract has failed.

## 8. Security invariants

The V3 safety work is retained as a floor, not discarded during the rewrite.

Mandatory invariants:

- no browser-supplied server base URLs or credentials;
- no arbitrary shell or filesystem path through generic tools;
- tool risk is declared before registration;
- unsupported risk classes fail closed;
- duplicate Tool/Capability IDs fail closed;
- plugin install performs preflight before mutation;
- external/destructive actions pass Approval Engine policy;
- traces exclude hidden chain-of-thought fields;
- compatibility adapters call the existing domain invariants rather than bypassing them.

## 9. Development method

This branch follows a Superpowers-style engineering loop:

1. clarify the problem from first principles;
2. define design/contracts before implementation;
3. add failing contract tests;
4. implement the smallest code that satisfies the contract;
5. run existing regression tests;
6. review architecture and security boundaries;
7. verify before declaring completion.

YAGNI applies: persistence engines, marketplaces, remote plugin installation, arbitrary dynamic code loading and UI redesign are not added until a concrete acceptance test requires them.

## 10. Migration gates

### Gate A — Foundation

Required:

- Kernel contracts;
- Plugin/Capability/Agent/Session/Tool/Approval/Scheduler contracts;
- plugin install composition;
- regression-safe CI.

### Gate B — Workbench migration

Required:

- V3 compatibility bridge;
- Personal Workbench mounted as an App;
- parity tests for Inbox/Todo/Project;
- existing UI remains usable.

### Gate C — External capabilities

Required:

- Feishu, GitHub/local workspace, GetNote and Joycrew isolated behind plugin/capability contracts;
- existing approval/readback rules preserved.

### Gate D — Engine ownership flip

Required:

- application boot starts Platform/Harness first;
- apps/plugins are loaded by composition;
- `src/server.mjs` stops owning business integrations directly;
- legacy bridge can be removed incrementally.

### Gate E — Extensibility proof

Required:

- AIHot or another external feature can be installed without Core edits;
- an Agent gains its tools only by declaring the capability;
- optional schedule/view can be composed separately.

## 11. Definition of done

The rewrite is not complete merely because new folders exist.

It is complete when:

1. Harness boots before Personal Workbench;
2. Personal Workbench is mounted from an app manifest;
3. Project/Inbox/Todo behavior passes parity tests through Harness tools;
4. Feishu/Joycrew/GetNote operate as extensions rather than server-owned special cases;
5. Session state is durable through a persistence adapter;
6. Approval is centralized;
7. scheduler dispatch is centralized;
8. an external plugin such as AIHot installs with Core zero-diff;
9. old Workbench contract tests, Harness E2E and Docker smoke stay green;
10. the legacy bridge is removable without changing the Harness contracts.
