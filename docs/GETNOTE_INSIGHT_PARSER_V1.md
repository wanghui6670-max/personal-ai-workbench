# GetNote Insight Parser v1

## Scope

This phase adds only the on-demand read and parse path:

```text
explicit caller
  -> getnote note <note_id> -o json
  -> select the real source-content field
  -> cache lookup
  -> strict structured AI parse (only on cache miss)
  -> exact evidence validation
  -> GetNoteInsightStore
```

It does **not** expose a UI action yet and does not create or modify Workbench tasks.

## Read-only GetNote command

The adapter executes exactly:

```text
getnote note <note_id> -o json
```

No GetNote update/delete/save command exists in this path.

Source selection follows GetNote CLI field semantics:

- text note: `content`
- web/link note: `web_content`
- recording/meeting note: `audio_original`
- blogger/live content: `post_media_text` only when it is actually present in the returned payload

For note types where `content` is normally an AI summary, missing raw content fails closed instead of parsing the summary as if it were source evidence.

v1 rejects raw content over 120,000 characters rather than silently truncating it. Chunked evidence-preserving parsing is a later capability.

## AI workflow isolation

The parser uses a dedicated provider workflow:

```text
getnote_insight
```

If `AI_PROVIDER_WORKFLOWS` is explicitly configured, that name must be allowed. The parser does not borrow `ai_console`, `project_progress`, or another workflow identity.

The cache model profile includes provider profile, adapter, model, reasoning mode, structured-output mode, and downgrade state. A cache entry is therefore not reused when the effective model profile changes.

## Evidence validation

The model first returns local evidence keys (`e1`, `e2`, ...). Before persistence:

1. every evidence excerpt must be an exact contiguous substring of the selected raw GetNote content;
2. local keys are converted to deterministic `ev_*` IDs;
3. all claim references must resolve to those evidence IDs;
4. the existing `GetNoteInsightV1` validator runs again before the immutable cache is written.

This prevents the model from persisting a paraphrase as if it were a source quote.

## Dates

`dueHint` may preserve vague source language such as `下周` or `尽快`.

`explicitDueDate` is accepted only if the candidate's own evidence contains a matching explicit calendar date (for example `8月20日`, `2026-08-20`, or equivalent numeric notation). Vague phrases cannot be converted into a formal date by the model.

## Cache

Before any provider request, the parser checks:

```text
noteId
+ SHA-256(raw selected content)
+ getnote insight parser version
+ effective model profile
```

A hit returns the immutable cached Insight and performs no AI request.

## Security and product boundary

- raw note content is sent only during an explicit parse call; there is no background scan;
- the raw full note is not written to `DATA_DIR/getnote/`;
- only bounded exact evidence excerpts are persisted;
- provider input still passes through the common outbound secret redaction layer;
- parser output cannot contain `today`, `priority`, `projectId`, `done`, or a direct Todo mutation;
- candidate review and task creation remain a separate human-gated phase.

## VPS note

The current GetNote adapter is CLI-based. A Docker/VPS runtime must deliberately provide an authenticated GetNote CLI execution environment before this feature can be exposed there. The parser does not assume that the host CLI is magically available inside the Workbench container.
