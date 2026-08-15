# GetNote Runtime Adapter v1

## Goal

Personal AI Workbench must not couple GetNote task sync or note intelligence to one machine's CLI process. Both consumers depend on the same read-only `GetNoteReader` contract:

```text
listNotes({limit,cursor})
fetchTodos(noteId)
fetchNote(noteId)
status()
```

The adapter supports two transports:

```text
local_cli
  Workbench -> execFile(getnote ...)

private_http
  Workbench/Docker -> authenticated private sidecar -> execFile(getnote ...)
```

`meeting_todos` parsing, note-type-aware raw-content selection, AI Insight parsing, cache identity and candidate review remain above this transport layer.

## Fixed read surface

The local transport and sidecar may execute only:

```text
getnote notes --limit <n> [--cursor <cursor>] -o json
getnote note todos <note_id> -o json
getnote note <note_id> -o json
```

There is no generic command endpoint and no save/update/delete route.

The sidecar exposes only:

```text
GET /health
GET /v1/notes?limit=<n>&cursor=<cursor>
GET /v1/notes/:noteId/todos
GET /v1/notes/:noteId
```

All data routes require a bearer service token of at least 32 characters. The health route contains no note data.

## Runtime modes

Default development mode:

```dotenv
GETNOTE_RUNTIME_MODE=local_cli
```

Private sidecar mode, intended for a Workbench container talking to a trusted host/private runtime:

```dotenv
GETNOTE_RUNTIME_MODE=private_http
GETNOTE_RUNTIME_BASE_URL=http://host.docker.internal:4310
GETNOTE_RUNTIME_SERVICE_TOKEN=<32+ random characters>
GETNOTE_RUNTIME_TIMEOUT_MS=45000
```

The client rejects public Internet origins. Accepted runtime locations are loopback, private IPs, Docker/internal single-label names, `host.docker.internal`, and `.internal`/`.local` names.

## Sidecar process

The sidecar still requires a real authenticated GetNote CLI on the machine where it runs. This repository does not yet package GetNote credentials into the Workbench image.

```dotenv
GETNOTE_RUNTIME_HOST=127.0.0.1
GETNOTE_RUNTIME_PORT=4310
GETNOTE_RUNTIME_SERVICE_TOKEN=<32+ random characters>
```

Start with:

```bash
npm run getnote:runtime
```

Non-loopback binding is rejected unless:

```dotenv
GETNOTE_RUNTIME_ALLOW_PRIVATE_BIND=1
```

and a valid service token is configured.

## Security and product boundaries

- Browser input cannot select a runtime URL or command.
- The service token is server-only and is not returned by `getnoteRuntimeConfig()`.
- HTTP redirects are rejected.
- Public hosts are rejected for `private_http` mode.
- No background scan is introduced.
- No GetNote writeback is introduced.
- No Todo, Inbox, Today, priority or Project mutation is added by this adapter.
- The sidecar does not make the Workbench image a credential store. VPS CLI installation/authentication remains a separate deployment step.

## Deployment intent

For a VPS-hosted Workbench container, the intended shape is:

```text
Internet
  -> HTTPS reverse proxy
  -> Workbench container
       -> private_http
       -> GetNote read-only runtime on trusted host/private network
            -> authenticated getnote CLI
```

This allows the Mac to be offline without teaching the Workbench business layer how GetNote is authenticated or executed.
