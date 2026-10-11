# Python API Worker

`brclio-xhs-python` preserves the independent Python engine behind the main
Worker's `PYTHON_API` service binding. It implements `/api/python-parse`,
`/api/python-image`, and `/api/python-video` (including existing underscore and
`.py` aliases). It has no public hostname and needs no secrets.

`src/parser_core.py` is generated from the pure definitions in
`api/python_parse.py`. Update the canonical parser, then run
`python3 cloudflare/python/sync_core.py`; do not edit the generated copy.
Workers-native asynchronous fetch replaces urllib, validates every redirect,
and enforces request, page, image, and video chunk limits. Video chunks retain
the exact Content-Range and byte-count checks required by the browser merger.

## Private rendered-page parsing

The main Worker's Browser Run experiment is disabled after failed production
canaries: its `BROWSER` binding was removed, so native parse failures no longer
start browser retries or incur new Browser Run session usage. Valid public
`/api/parse_verification` requests also return 503 before looking up or dispatching
a session Durable Object when the binding is absent. The modules, tests,
private Python helper and website verification UI remain as inactive preparation.

The retained experiment first attempts an ordinary page read. If it
identifies CAPTCHA, the website can offer official Live View for the user to
complete verification manually, then read the same isolated session. It does
not solve challenges automatically or share login cookies. Node and Python
continue to use their own parsers; Python does not consume Node's parsed JSON.

Only the private service-binding path `POST /__internal/parse-rendered-note`
accepts JSON with exactly three string fields: `finalUrl`, `html`, and `noteId`.
The final URL must be HTTPS on `xiaohongshu.com` or `www.xiaohongshu.com`, use a
supported note path, and match the supplied note ID; credentials, fragments and
unsupported ports are rejected. HTML is limited to 6 MiB of UTF-8, and the
serialized envelope to 6 MiB + 16 KiB. This helper performs no network fetch,
accepts no cookies or arbitrary request headers, and uses the same independent
Python parser and public playback response shaping as native parsing. Protected
original-video URLs remain excluded from the anonymous response.

The public main Worker returns 404 for `/__internal/*`; caller-controlled headers
cannot enable this route. The public `/api/python_parse` request remains limited
to 16 KiB and takes share text, not supplied HTML. The Python Worker still has no
public hostname and needs no Browser Run binding or account secrets.

Experimental browser ownership, cancellation and expiry belong to the main Worker's
`ParseRuntime`, with one private bearer-token owner per 180-second session.
Durable Object storage contains a numeric budget and temporary lifecycle data,
including the source URL, which may carry share query parameters. The URL is
private and deleted during closure; HTML, cookies and Live View URLs are not
persisted. Historical numeric budget records remain after disabling the binding;
the recorded canary sessions were closed, and no new sessions or budget writes
start without the binding. This does not move account or feedback data out of GitHub.

## Current release evidence

The 2026-10-11 rendered helper was deployed from source
`9fdae65898cd67be0edc6f7e0f96b2cd35eb25d1` as Python version
`6d84f091-8d1c-426d-9eb6-5aa53cf06dd3`. Its 59 related checks passed, including
real workerd and independent parser tests. A later main Worker classification
and safe-diagnostics patch did not change that Python deployment.

Two real Node Browser Run video canaries returned 422 without a usable
verification entry, both with `BROWSER_PAGE_REJECTED` and confirmed closure.
The second safe summary identified an upstream error page. The subsequent Python
video test also returned 422 without verification, with the same error-page
summary and confirmed closure. A Node image-note test returned 422 without
verification outside the tail window, so its browser failure cause is unconfirmed.
No experiment produced a positive result. The final disabled release is from source
`aced84ecd75d1bcf9e0d922498e2fc9b6e4ebd70`, without changing
the Python or Pages deployment; the final main Worker version is
`8443f3c1-c8af-4ee8-91bf-397e73e149d6`. The final disabled-path and verification
guard suite passed 32 checks, including no owner-object dispatch without the
binding. Manual verification and real rendered-page
parsing remain unverified; local test passes do not establish production success. See the
[Browser Run follow-up](../../docs/releases/v2.0.15-cloudflare-browser-followup.json)
and [deployment history](../../docs/cloudflare-deployment.md), which retain the
earlier native CAPTCHA and failed-parse evidence.

## Local checks and deployment

From this directory, with `uv` and Node.js installed:

```sh
uv sync --frozen
uv run pywrangler sync
python3 sync_core.py --check
uv run python tests/runtime_test.py
uv run pywrangler deploy --dry-run
uv run pywrangler deploy
```

Deploy this service before the main Worker. The runtime tests launch an isolated
local workerd process, use the production entrypoint and parser, and replace only
outbound fetch with deterministic upstream fixtures. The fixture entrypoint is
outside `src` and is never bundled in production. Tests exercise note parsing,
Live Photos, audio metadata, binary media bodies, bad redirects, request limits,
and video range integrity. The existing Python suite also remains applicable:

```sh
python3 -m unittest discover -s ../../test -p test_python_backend.py
python3 -m unittest discover -s ../../test -p test_python_cloudflare_diagnostics.py
```

The private helper tests also cover exact input fields, URL/note identity,
method and byte limits, no outbound fetch, and anonymous original-video
redaction. They do not acquire a production browser or solve a real challenge.

For a local service-binding session, run `uv run pywrangler dev --port 8790`
alongside the main Worker. `python_modules`, virtual environments, runtime state,
and secrets are ignored by Git; `uv.lock` and `pylock.toml` are committed.
