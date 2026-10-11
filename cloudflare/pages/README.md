# Pages domain gateway

This small Pages project provides a custom subdomain that can be connected by
an external CNAME. The authoritative DNS zone does not need to belong to the
Cloudflare account hosting this Pages project. Add the custom domain in Pages
first, then set its DNS CNAME to the project's actual `pages.dev` hostname.
Creating only the CNAME without registering the domain in Pages can return 522.
See [Pages custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).

`_worker.js` forwards `/api/*` and `/admin*` to the existing
`brclio-xhs-downloader` Worker using the `APP` service binding. Requests and
responses pass unchanged, preserving JSON bytes, cookies, Origin, client IP,
redirects and binary Range responses. The main Worker continues to own every
account Secret and the private Python service binding. Pages needs no Secrets.

The production hosting path uses Cloudflare only: Pages calls the main Worker,
and Python API requests continue through its private `PYTHON_API` service
binding. A Vercel project is not a prerequisite for this gateway or its release.
Earlier migration and failed-fallback observations remain historical evidence
in the migration record; they are not instructions to restore that backend.

`_routes.json` limits Function invocation to those API and administrator paths.
Other static requests are served directly by Pages. `deploy/build-pages.mjs`
first builds the existing public allowlist into `dist-web`, then copies it and
the two gateway files into `cloudflare/pages/dist`. The output is ignored by
Git and contains no backend source or environment files. See
[advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/),
[service bindings](https://developers.cloudflare.com/pages/functions/wrangler-configuration/#service-bindings)
and [invocation routes](https://developers.cloudflare.com/pages/functions/routing/#functions-invocation-routes).

## Build and deploy

From the repository root:

```sh
node deploy/build-pages.mjs
node --test test/cloudflare-pages.test.js
WRANGLER_SEND_METRICS=false node node_modules/wrangler/bin/wrangler.js pages functions build-env cloudflare/pages --outfile /dev/null --env-file=/dev/null
```

The `brclio-xhs-pages` Pages project has been created and deployed. Use the
deployment command below for routine updates; do not recreate it. If setting up
a separate new Pages project with the pinned Wrangler 4.136.2, initial creation
uses:

```sh
npx wrangler pages project create brclio-xhs-pages --production-branch main --force --cwd cloudflare/pages
```

The initial `--force` is intentional: this Wrangler version automatically
delegates creation of new Pages projects to Workers unless this option is set.
This gateway specifically requires Pages' external-CNAME custom-subdomain
support. `--force` selects that platform; it does not authorize overwriting
business data. Confirm the resulting resource is a Pages project before
deploying. The behavior and option are present in the installed Wrangler CLI's
Pages project-create implementation.

After the Pages project exists, deploy with:

```sh
CLOUDFLARE_ACCOUNT_ID=c8b059429c868f6d0e528f9e10325f46 npx wrangler pages deploy --cwd cloudflare/pages --project-name brclio-xhs-pages --branch main
```

The existing production account ID above was verified against both live
resources on 2026-10-11. Authenticate to that account before deploying; do not
infer ownership from a cached Wrangler directory or a browser's current
account. Pages does not support `account_id` in its Wrangler configuration.
Select it through `CLOUDFLARE_ACCOUNT_ID`; the main and Python Worker configs
can pin `account_id` directly. The offline `build-env` command above invokes
the actual Pages configuration validator in pinned Wrangler 4.136.2 and does
not deploy or require login. Run it alongside the gateway tests: the general
Worker schema alone does not catch unsupported Pages fields.

Do not use `wrangler deploy` here: that command targets Workers. Deploy the
main and Python Workers first when their code or bindings need updating, using
the repository's existing Cloudflare scripts. An unchanged Python Worker can
retain its existing deployment; verify its service binding and API responses.
Run the gateway build again after any public-file changes. Creation
via Direct Upload does not enable automatic Git deployments; use this command
in the release process or a separately configured CI job.

Keep `AUTH_SITE_ORIGIN` on the main Worker set to the original production
origin. Pages previews are not trusted administrator origins. The gateway
does not rewrite Origin or relax account access checks.

## Local verification

Start the Python Worker in another terminal, then from `cloudflare/pages` run:

```sh
../../node_modules/.bin/wrangler pages dev -c wrangler.jsonc -c ../../wrangler.jsonc --port 8789 --inspector-port 9240
```

This explicitly selects both the Pages and main Worker configurations. In the
pinned Wrangler version, standalone Pages dev in this nested directory can
re-discover the repository-root config during runtime startup and omit `APP`;
the documented multiple-config mode avoids that ambiguity. The main Worker
then connects to the running Python service by its Worker name.

From the repository root:

```sh
node scripts/verify-cloudflare.mjs http://127.0.0.1:8789 --json
```

The gateway's four focused tests and all 44 anonymous checks passed locally on
2026-09-23. They cover request/response preservation, cookies, binary bytes,
admin routes, static routing, public build boundaries and both API engines.
This is local evidence. The deployed gateway and Workers subsequently completed
a real SMTP login-code delivery and administrator verification on 2026-09-23.
Domain activation, the final production acceptance results and outstanding
checks are tracked in [the migration record](../../docs/cloudflare-deployment.md).
