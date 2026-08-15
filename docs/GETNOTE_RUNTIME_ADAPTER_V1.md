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

## Pagination contract

Current official GetNote CLI uses `data.cursor` as the recommended continuation cursor. Workbench therefore prefers:

```text
data.cursor
```

and accepts `next_cursor` / `nextCursor` only as compatibility fallbacks. Cursor values stay strings end to end so 64-bit note identifiers are never coerced through JavaScript numbers.

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

The sidecar still requires a real authenticated GetNote CLI on the machine where it runs. This repository does not package GetNote credentials into the Workbench image.

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

## Child-process environment isolation

`local_cli` and the sidecar do **not** forward the full Workbench process environment to `getnote`. The child receives only the minimum runtime/network environment plus GetNote authentication overrides:

```text
HOME / PATH / USER / LOGNAME / TMPDIR
LANG / LC_*
XDG_CONFIG_HOME
HTTP(S)_PROXY / ALL_PROXY / NO_PROXY
SSL_CERT_FILE / SSL_CERT_DIR / NODE_EXTRA_CA_CERTS
GETNOTE_API_KEY / GETNOTE_CLIENT_ID
```

Workbench password/session secrets, AI Provider keys, Joycrew tokens and the private Runtime service token are not exposed to the GetNote CLI child process. `npm run doctor` uses the same environment policy for `getnote doctor -o json`.

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
