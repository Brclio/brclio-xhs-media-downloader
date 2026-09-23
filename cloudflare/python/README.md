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
```

For a local service-binding session, run `uv run pywrangler dev --port 8790`
alongside the main Worker. `python_modules`, virtual environments, runtime state,
and secrets are ignored by Git; `uv.lock` and `pylock.toml` are committed.
