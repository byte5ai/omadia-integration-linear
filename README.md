# @omadia/integration-linear

The **Linear connection** for omadia: it holds the credential for one Linear
workspace and publishes the **Linear API capability** (`linear.api@2`) so other
plugins can read and change issues without ever seeing the key.

This is one half of the Linear Integration. The other half is
`@omadia/agent-linear`, which carries the tools and the prompt and consumes
this capability. This package has no tools, no prompt and no routes.

- **Install, use, known limits, troubleshooting**: the agent's README
  (`@omadia/agent-linear`) — install this package first, then the agent.
- **Client contract** (what consumers read): [INTEGRATION.md](./INTEGRATION.md)
- **Vocabulary**: `CONTEXT.md` in the source repository (not shipped in the
  plugin package — the zip carries only runtime artefacts)

## What it does

`activate(ctx)` reads `linear_api_key` from the plugin vault, builds a GraphQL
client over the host's allow-listed `ctx.http.fetch`, and registers it as
`linear.api`. It sends nothing to Linear, so a Linear outage cannot fail an
activation or slow a core boot.

Egress is the one host `api.linear.app`, declared in
`permissions.network.outbound`. There is no other network surface.

## Connection status

Whether the stored key works shows in the Store, not only in a log:

- After every activation — install, boot, a changed key — core runs the
  plugin's `verifyConnection` export: one `viewer` query, four seconds at
  most. A key Linear refuses turns the plugin's badge red and puts a banner on
  its page.
- The plugin's page has a button **Verbindung testen** that runs the same
  check on request and answers in place: "Verbindung funktioniert — <name of
  the key's owner>", "Das Zielsystem hat die Zugangsdaten abgelehnt", or that
  the connection could not be checked. In a workspace whose owner has no
  display name, the name shown is the owner's e-mail address.
- Between two checks the requests themselves keep the status current: one
  that Linear refuses for the key sets the status to error, the next one that
  succeeds clears it.

Only an explicit refusal of the key counts as rejected — HTTP 401, a 403 that
names authentication, or an authentication error inside the GraphQL answer. A
timeout, a 5xx, a rate limit or an unreachable network is "could not be
checked" and leaves the status as it was, because a red status also withholds
a plugin's tools from the orchestrator. The reason for a check that could not
decide is in the log:

```
[linear] connection ok — key acts as Ada Lovelace (a1b2…)
[linear] connection check: Linear rejected the API key (http_401)
[linear] connection check inconclusive — linear: HTTP 502
```

The check sends no badge text of its own. The plugin cannot see the operator's
language, and the admin UI words each state itself; the price is that a
working key shows as the absence of a red badge plus the answer of the button,
not as a green badge.

The host package `@omadia/plugin-api` is imported for its types only, so the
plugin loads on every core in its `compat.core` range. A core that predates
the connection check ignores the export.

## Why a hand-written GraphQL client

`@linear/sdk` calls `globalThis.fetch` directly and exposes no injection point.
Using it would route every request around the host's outbound allow-list and
per-plugin rate limiter — the two guarantees `ctx.http` exists to provide. So
`src/client.ts` speaks GraphQL itself and the package has **zero runtime
dependencies**. (`@linear/sdk` becomes worth reconsidering only for
`@linear/sdk/webhooks`, which matters for Push and is not in scope.)

## Setup

You need a Linear workspace and a **personal API key** of a member of it
(Linear → Settings → Security & access → Personal API keys). Linear's Free
plan is enough. A key restricted to reading passes the connection check, but
every change fails at Linear; set the agent's write mode to "off" for such a
key.

One field, in the install drawer:

| Field | Type | Where it comes from |
|---|---|---|
| `linear_api_key` | secret, required | Linear → Settings → Security & access → Personal API keys |

The key acts as its owner: issues created through omadia are attributed to that
person, and "assign it to me" resolves to them.

**Changing the key:** open the connection's page in the Store → section
**Setup-Felder editieren** → field `linear_api_key` (shown as "gespeichert ·
neu eintippen zum Überschreiben") → type the new key → **Speichern**. The
plugin is reactivated, the agent with it, and the connection is checked
again. To rotate, create the new key in Linear, paste it here, then revoke
the old one.

## Build and install

```bash
npm install
npm run build          # typecheck + tests + out/omadia-integration-linear-<version>.zip
```

`npm run build` is a gate, not just a packaging step: a red compiler or a
failing test cannot produce an uploadable zip. Hub versions are immutable, so a
bad artefact is a permanent one. `npm run build:only` skips the gate on
purpose, for iterating on packaging.

Install the zip in the web UI:

1. Open the **Store** (`/store`), choose **Lokal** in the source switch at the
   top (Registry / Lokal / Installiert).
2. In the box "Neues Agent-Package hochladen." → **Datei wählen** → the zip.
   Expect "✓ Hochgeladen"; the card **Linear** (kind integration) appears.
3. Install the card, paste the key into **Linear-API-Schlüssel** in the
   drawer's "Einrichtung", **Installation bestätigen**.
4. On the plugin's page press **Verbindung testen**.

**Updating:** upload a newer zip the same way. It replaces the installed
version, carries the settings over and reactivates the plugin and the agent
that depends on it; there is no install step. A version that is already
installed, or an older one, is rejected. When a release changes the
capability version (`linear.api@1` → `@2`), upload this package before the
agent.

Or via the API:

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
including Linear's failure shapes and the verdict the connection check draws
from each. What no unit test here can pin is
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

**In:** issue read, search by filter and page by page, create, update,
comment; lookups for teams, workflow states, users, labels, projects and
cycles.

**Out:** delete/archive; project, cycle, estimate and parent edits; documents,
attachments, initiatives, customers; Push (Linear → omadia); per-user identity
via OAuth. See INTEGRATION.md for the reasoning on each.

## License

MIT — see [LICENSE](./LICENSE).
