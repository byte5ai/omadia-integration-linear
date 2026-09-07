# @omadia/integration-linear

The **Linear connection** for omadia: it holds the credential for one Linear
workspace and publishes the **Linear API capability** (`linear.api@1`) so other
plugins can read and change issues without ever seeing the key.

This is one half of the Linear Integration. The other half is
`@omadia/agent-linear`, which carries the tools and the prompt and consumes
this capability. This package has no tools, no prompt and no routes.

- **Client contract** (what consumers read): [INTEGRATION.md](./INTEGRATION.md)
- **Vocabulary**: `CONTEXT.md` in the source repository (not shipped in the
  plugin package — the zip carries only runtime artefacts)

## What it does

`activate(ctx)` reads `linear_api_key` from the plugin vault, builds a GraphQL
client over the host's allow-listed `ctx.http.fetch`, and registers it as
`linear.api`. It then fires a single `viewer` query as a connection check —
detached and non-fatal, so a Linear outage cannot block a core boot. The result
appears in the log as either

```
[linear] connection ok — key acts as ada (a1b2…)
[linear] connection check FAILED — linear: API key rejected (HTTP 401)
```

Egress is the one host `api.linear.app`, declared in
`permissions.network.outbound`. There is no other network surface.

## Why a hand-written GraphQL client

`@linear/sdk` calls `globalThis.fetch` directly and exposes no injection point.
Using it would route every request around the host's outbound allow-list and
per-plugin rate limiter — the two guarantees `ctx.http` exists to provide. So
`src/client.ts` speaks GraphQL itself and the package has **zero runtime
dependencies**. (`@linear/sdk` becomes worth reconsidering only for
`@linear/sdk/webhooks`, which matters for Push and is not in scope.)

## Setup

One field, in the install drawer:

| Field | Type | Where it comes from |
|---|---|---|
| `linear_api_key` | secret, required | Linear → Settings → Security & access → Personal API keys |

The key acts as its owner: issues created through omadia are attributed to that
person, and "assign it to me" resolves to them. Rotating means revoking the old
key in Linear and pasting a new one here.

## Build and install

```bash
npm install
npm run build          # typecheck + tests + out/omadia-integration-linear-<version>.zip
```

`npm run build` is a gate, not just a packaging step: a red compiler or a
failing test cannot produce an uploadable zip. Hub versions are immutable, so a
bad artefact is a permanent one. `npm run build:only` skips the gate on
purpose, for iterating on packaging.

Install the zip through **Admin → Store → tab "Lokal" → upload**, or via the
API:

```bash
POST /api/v1/install/plugins/@omadia%2Fintegration-linear
POST /api/v1/install/jobs/<id>/configure     # paste the key here
```

`PLUGIN_DEV_DIR` does not work for this package — the Docker stack mounts no
source directory.

Typechecking resolves `@omadia/plugin-api` through a `paths` alias into the
adjacent core checkout (`../omadia/middleware/packages/plugin-api/dist`). A
stale checkout there means typechecking against an outdated host API, so pull
and rebuild core before trusting a green run.

## Tests

```bash
npm test        # node:test via esbuild transpile, no framework
npm run typecheck
```

Everything is offline. The client is driven against a mocked `ctx.http.fetch`,
which pins the request the client builds and the way it maps each response —
including Linear's three failure shapes. What no unit test here can pin is
agreement with Linear's actual schema; that is what a manual pass against the
`omadia-dev` workspace is for, and it should be run before this package is
pointed at a real workspace.

## Deviations from the package contract

Two rules in the boilerplate package contract
(`omadia/middleware/assets/boilerplate/agent-integration/CLAUDE.md`,
"Stolperfallen") are not followed here. Both are deliberate, and both are
written down rather than left as a surprise:

- **"`[0]` nicht verwenden → Lodash `_.first()`."** Lodash would be the first
  and only runtime dependency in a package that has none, and would have to be
  inlined into `dist/plugin.js`. `src/client.ts` carries a three-line local
  `first()` helper instead, which satisfies what the rule is protecting against
  — and `noUncheckedIndexedAccess` makes the compiler enforce it anyway.
- **"Kein `any` — `unknown` + Zod-Parse bei externen Payloads."** No `any`
  appears anywhere, and the response *envelope* is checked at runtime
  (`errors[]` before status, then a present-and-non-null `data`). What is
  trusted is the *field types inside* `data`, because the query text that pins
  the selection set sits in the same file as the shape it produces. Mirroring
  every selection in a Zod schema would add a runtime dependency for drift that
  a removed field already surfaces as a GraphQL error. The residual risk is a
  field whose type changed under a name that stayed — worth revisiting if it
  ever bites, and worth a maintainer's second opinion now.

## Scope

**In:** issue read, search, create, update, comment; lookups for teams,
workflow states, users and labels.

**Out:** delete/archive; project, cycle, estimate and parent edits; documents,
attachments, initiatives, customers; Push (Linear → omadia); per-user identity
via OAuth. See INTEGRATION.md for the reasoning on each.

## License

MIT — see [LICENSE](./LICENSE).
