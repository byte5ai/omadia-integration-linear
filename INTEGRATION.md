# `@omadia/integration-linear` — Integration Surface

**Source of truth for anything that consumes the Linear connection.** Read
this before writing code against it, and do not trust a training-memory of
"the Linear API": the surface below is deliberately much narrower than
Linear's GraphQL schema, and several methods behave differently from their
obvious upstream equivalent.

Vocabulary (connection, Linear API capability, lookup, workflow state,
prepared write, commit, preview) is defined in the `CONTEXT.md` of the
`omadia-integration-linear` source repository. This file uses those terms
without redefining them; that document is not shipped in the plugin package.

## Service registry

| Service name | TypeScript type | Purpose |
|---|---|---|
| `linear.api` | `LinearClient` | The Linear API capability: reads plus the three writes |

The capability is versioned major-only: the connection declares
`provides: ["linear.api@2"]`, a consumer declares `requires: ["linear.api@^2"]`.

## Consumption pattern

A consuming plugin needs both declarations. `requires:` is what makes
`ctx.services.get` legal and orders activation; `depends_on:` is what makes the
secret chain resolve.

```yaml
# manifest.yaml of the consumer
depends_on:
  - "@omadia/integration-linear"
requires:
  - "linear.api@^2"
```

```typescript
import type { LinearClient } from '@omadia/integration-linear';

const linear = ctx.services.get<LinearClient>('linear.api');
if (!linear) {
  throw new Error(
    "linear.api unavailable — declare requires: ['linear.api@^2'] and install " +
      '@omadia/integration-linear',
  );
}
```

The import is for types only; nothing of this package is loaded at runtime.
So `package.json` of the consumer lists it nowhere: resolve the types at build
time, for example with a `paths` entry in `tsconfig.json` that points at this
package's `dist/plugin.d.ts`. Do **not** add it to `peerDependencies`. The
host's upload check compares that list with its own packages only, so a
sibling plugin named there is reported to the operator as a missing
dependency on every upload, however correctly it is installed.

Two rules that fail silently rather than loudly if you break them:

- **Do not redeclare `linear_api_key`** as a setup field of the consumer. The
  secret resolves along the `depends_on` chain on its own; a redeclared field
  overrides the parent's value with an empty one and nothing warns.
- **Do not construct `createLinearClient` yourself** in a consumer. The key
  lives in this plugin's vault namespace and the outbound allow-list
  (`api.linear.app`) is granted to this plugin only — a client built elsewhere
  either has no credential or no egress. It would also report nothing to the
  connection status (below).

## `LinearClient` — verbatim

```typescript
interface LinearClient {
  /** The key's owner. Also what "assign it to me" resolves to. */
  viewer(): Promise<LinearUser>;

  teams(): Promise<LinearTeam[]>;

  /** Workflow states of one team, ordered by their position in the board. */
  workflowStates(teamId: string): Promise<LinearWorkflowState[]>;

  /** Workspace members; `query` matches name, display name or e-mail. */
  users(query?: string): Promise<LinearUser[]>;

  /** Labels of one team plus the workspace-wide ones, or all labels. */
  labels(teamId?: string): Promise<LinearLabel[]>;

  /** Every project of the workspace that is not archived. */
  projects(): Promise<LinearProject[]>;

  /** Cycles of one team, ordered by number. */
  cycles(teamId: string): Promise<LinearCycle[]>;

  /** One page of issues, most recently updated first; by relevance with `text`. */
  searchIssues(input: SearchIssuesInput): Promise<LinearIssuePage>;

  /** By key (`OMA-7`) or by id. `undefined` when there is no such issue. */
  getIssue(keyOrId: string): Promise<LinearIssueDetail | undefined>;

  createIssue(input: CreateIssueInput): Promise<LinearIssue>;
  updateIssue(id: string, input: UpdateIssueInput): Promise<LinearIssue>;
  addComment(issueId: string, body: string): Promise<LinearComment>;
}
```

### Types

```typescript
type LinearWorkflowStateType =
  | 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled';

interface LinearUser {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly active: boolean;
}

interface LinearTeam {
  readonly id: string;
  readonly key: string;   // 'OMA'
  readonly name: string;
}

interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;                    // 'In Progress'
  readonly type: LinearWorkflowStateType;
  readonly position: number;
  readonly teamId: string;
}

interface LinearLabel {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | undefined;      // undefined = workspace-wide
}

interface LinearIssueRef {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

type LinearProjectStatusType =
  | 'backlog' | 'planned' | 'started' | 'paused' | 'completed' | 'canceled';

interface LinearProject {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status: {
    readonly name: string;                  // the workspace's own wording
    readonly type: LinearProjectStatusType;
  };
  readonly startDate: string | undefined;   // 'YYYY-MM-DD'
  readonly targetDate: string | undefined;  // 'YYYY-MM-DD'
}

type LinearCyclePhase = 'past' | 'previous' | 'current' | 'next' | 'future';

interface LinearCycle {
  readonly id: string;
  readonly number: number;                  // counts up per team
  readonly name: string | undefined;        // undefined = shown as 'Cycle 12'
  readonly startsAt: string;                // ISO-8601
  readonly endsAt: string;
  readonly phase: LinearCyclePhase;
  readonly teamId: string;
}

interface LinearProjectRef {
  readonly id: string;
  readonly name: string;
}

interface LinearCycleRef {
  readonly id: string;
  readonly number: number;
  readonly name: string | undefined;
}

interface LinearIssue {
  readonly id: string;
  readonly identifier: string;              // 'OMA-7' — the key users say
  readonly title: string;
  readonly url: string;
  readonly priority: number;                // 0 none, 1 urgent … 4 low
  readonly priorityLabel: string;           // 'High'
  readonly createdAt: string;               // ISO-8601
  readonly updatedAt: string;
  readonly completedAt: string | undefined; // entered a completed state; undefined while not in one
  readonly canceledAt: string | undefined;  // entered a canceled/duplicate state; same rule
  readonly state: {
    readonly id: string;
    readonly name: string;
    readonly type: LinearWorkflowStateType;
  };
  readonly assignee: LinearIssueRef | undefined;
  readonly team: LinearTeam;
  readonly labels: readonly string[];       // label NAMES, not ids
  readonly project: LinearProjectRef | undefined;
  readonly cycle: LinearCycleRef | undefined;
}

interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  readonly author: string | undefined;      // undefined = app-authored
}

interface LinearIssueDetail extends LinearIssue {
  readonly description: string | undefined;
  readonly comments: readonly LinearComment[];
}

interface LinearDateRange {
  readonly from?: string;                   // at or after this moment
  readonly before?: string;                 // before this moment
}

interface SearchIssuesInput {
  readonly teamKey?: string;                // 'OMA', not the team id
  readonly stateType?: LinearWorkflowStateType;
  readonly assigneeId?: string;
  readonly creatorId?: string;
  readonly labelId?: string;                // issues that carry this label
  readonly priority?: number;               // 0 none, 1 urgent … 4 low
  readonly projectId?: string;
  readonly cycleId?: string;
  readonly createdAt?: LinearDateRange;
  readonly updatedAt?: LinearDateRange;
  readonly completedAt?: LinearDateRange;   // completed issues only
  readonly text?: string;                   // switches to full-text search
  readonly limit?: number;                  // default 25, hard cap 100
  readonly cursor?: string;                 // nextCursor of the page before
}

interface LinearIssuePage {
  readonly issues: readonly LinearIssue[];
  readonly nextCursor: string | undefined;  // undefined = last page
}

interface CreateIssueInput {
  readonly teamId: string;                  // an ID — resolve it via teams()
  readonly title: string;
  readonly description?: string;            // Markdown
  readonly stateId?: string;
  readonly assigneeId?: string;
  readonly priority?: number;
  readonly labelIds?: readonly string[];
}

interface UpdateIssueInput {
  readonly title?: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly assigneeId?: string | null;      // null clears the assignee
  readonly priority?: number;
  readonly labelIds?: readonly string[];    // replaces the whole set
}
```

Exported constants: `LINEAR_GRAPHQL_ENDPOINT`, `DEFAULT_ISSUE_LIMIT` (25),
`MAX_ISSUE_LIMIT` (100), `MAX_COMMENTS` (100), `LOOKUP_PAGE_SIZE` (250),
`MAX_LOOKUP_NODES` (5,000).

## Behaviour that is not obvious from the signatures

- **`searchIssues` runs one of two queries.** With `text`, it uses Linear's
  full-text search and applies the other fields as a filter; Linear orders
  those results by relevance and allows 30 such searches per minute. Without
  `text`, it lists issues by the same filter, most recently updated first.
  Both clamp `limit` to 100 — a search feeds a model context, and an unbounded
  one is a context overflow waiting for a busy team.
- **`searchIssues` returns one page and says whether there is another.**
  `nextCursor` is set whenever Linear holds more matches than the page
  carries. Send it back as `cursor`, with every other field unchanged, for the
  page after. A cursor used with different filters pages through a different
  list.
- **The filter fields combine with "and".** `labelId` matches issues that
  carry that label among others. `completedAt` matches completed issues only:
  a canceled issue has no completion time and is found by
  `stateType: 'canceled'` with `updatedAt`.
- **A bound of a `LinearDateRange` is one of three things:** an ISO-8601
  timestamp, a `YYYY-MM-DD` date (midnight UTC), or a duration counted from
  the moment the query runs — `-P7D` is seven days ago, `-P2W` two weeks,
  `-P1M` a month. `from` is inclusive, `before` exclusive, so
  `{ from: '2026-11-02', before: '2026-11-09' }` is exactly that week. The
  client sends a bound as given; a value Linear cannot read comes back as a
  `LinearGraphQLError`.
- **`getIssue` accepts both forms and never throws for "not found".** A key is
  resolved deterministically as team key plus issue number; anything else is
  treated as an id. A miss is `undefined`, not an error.
- **Every lookup reads its collection to the end.** `teams`,
  `workflowStates`, `users`, `labels`, `projects` and `cycles` follow Linear's
  cursor in pages of `LOOKUP_PAGE_SIZE` until nothing is left, so a name on a
  later page resolves like one on the first. A collection of more than
  `MAX_LOOKUP_NODES` records fails with a `LinearApiError` instead of coming
  back in part: a lookup that saw only some of the records would resolve a
  name to the wrong id.
- **`workflowStates`, `users` and `labels` narrow in process**, after reading
  the workspace's whole collection. `cycles` is narrowed to its team by
  Linear, because the cycles of a workspace grow with every week it exists.
- **`cycles` tells where each cycle stands today.** `phase` is `current` for
  the cycle that is running. A team between two cycles, or one that does not
  use cycles, has no current one. `previous` and `next` are today's two
  neighbours.
- **`projects` is workspace-wide.** A project can span teams, so there is no
  team argument. Archived projects are left out; completed and canceled ones
  are listed, and `status.type` tells them apart.
- **`labels(teamId)` keeps workspace-wide labels.** A label with no team is
  usable on every team's issues, so narrowing to a team must not drop it.
- **`updateIssue` sends only the keys you set.** An omitted key leaves the
  field alone; `assigneeId: null` clears it. An update with no fields at all is
  refused before the request goes out — it would come back `success: true` and
  be reported to a user as a change that happened.
- **`labelIds` replaces the label set**, it does not add to it. Read the
  current labels first if you mean to append.
- **"Closing" an issue is a state change.** Move it to a state whose `type` is
  `completed` or `canceled`; Linear has no close operation.
- **These three writes mutate Linear immediately.** The
  prepared-write/preview/commit flow that fronts them for users belongs in the
  consuming agent, not here — this layer has no conversation to preview into.

## Connection status

Whether the stored key works is visible to the operator in the Store: a red
badge and a banner on the plugin's page when Linear refused the key, and a
"check connection" button that answers on request. Two things feed it.

- **The connection check.** The plugin exports `verifyConnection(ctx)` next to
  `activate`. The host runs it after every activation and when the operator
  presses the button. It sends one `viewer` query and answers:

  | Verdict | When |
  |---|---|
  | `connected` | Linear answered with the key's owner; their name is the `detail` |
  | `rejected`, cause `http_401` | HTTP 401 |
  | `rejected`, cause `http_403_auth` | HTTP 403 whose body names authentication |
  | `rejected`, cause `protocol_auth_failure` | an authentication error in `errors[]` under any other status, HTTP 200 included |
  | `inconclusive` | everything else: timeout (4 s), 5xx, rate limit, network failure, a 403 that names no authentication, an answer that is not GraphQL, no key stored |

  An inconclusive check changes nothing; its reason is in the plugin's log.

- **Every request made through `linear.api`.** A request Linear refuses for
  the key (the `LinearAuthError` below) sets the status to error at once, so a
  key revoked in Linear shows up without anyone pressing the button. The next
  request that succeeds clears it again.

`activate()` itself sends nothing to Linear.

What this means for a consumer: nothing to call and nothing to report. While
the status is error, the host withholds the tools **this** plugin registers;
it registers none, so whether a consumer's tools stay available is decided by
the consumer's own status.

## Errors

Every failure is one of these five. `LinearApiError` is the base, so a
consumer that only wants "did it work" can catch that one.

```typescript
class LinearApiError extends Error {
  readonly status: number;            // upstream HTTP status, 0 if none
  readonly body: string | undefined;  // upstream body, truncated to 1000 chars
}

/** Linear refused the key: missing, revoked or malformed. Not retryable —
 *  the operator must paste a new key. */
class LinearAuthError extends LinearApiError {
  /** 'http_401' | 'http_403_auth' | 'protocol_auth_failure' — the same three
   *  cases as in the connection-check table above. */
  readonly rejection: LinearAuthRejection;
}

/** Linear's request or complexity budget is spent. Linear answers with
 *  HTTP 429, `RATELIMITED` in the error extensions and a `Retry-After`
 *  header. */
class LinearRateLimitError extends LinearApiError {
  /** When to try again: `Retry-After` counted from the arrival of the answer,
   *  otherwise `x-ratelimit-requests-reset`, otherwise undefined. */
  readonly resetAt: Date | undefined;
}

/** Linear answered with `errors[]` for any other reason. `message` joins
 *  every upstream message with '; '. */
class LinearGraphQLError extends LinearApiError {
  readonly errors: readonly LinearGraphQLErrorEntry[]; // { message, extensions? }
}

/** A mutation returned `success: false`. Linear accepted the request and
 *  declined the change — never report this to a user as done. */
class LinearMutationError extends LinearApiError {}
```

`LinearRateLimitError` is raised for HTTP 429 whatever the body says, and for
`RATELIMITED` in the extensions under any status — until 2026-11-05 Linear
sent that body under HTTP 400. Compare by `err.name` rather than `instanceof`
when the error crosses into another plugin's bundle.

A 403 that names no authentication (a permission, a plan, a region) is a plain
`LinearApiError`: it is not a verdict on the key.

Two limits worth designing around: a personal API key is capped at roughly
2,500 requests per hour, and the host's own `ctx.http` allows 60 requests per
minute per plugin (`HttpRateLimitError`, thrown by the host, not by this
client). Cache lookups rather than re-resolving a team key on every turn.

## Snippets

Resolve a team key and a state name to ids, then move an issue:

```typescript
const team = (await linear.teams()).find((t) => t.key === 'OMA');
if (!team) throw new Error('no team OMA');

const done = (await linear.workflowStates(team.id)).find((s) => s.type === 'completed');
if (!done) throw new Error('team OMA has no completed state');

const issue = await linear.getIssue('OMA-7');
if (!issue) throw new Error('OMA-7 does not exist');

await linear.updateIssue(issue.id, { stateId: done.id });
```

"What is assigned to me and still open?":

```typescript
const me = await linear.viewer();
const { issues: open } = await linear.searchIssues({
  teamKey: 'OMA',
  assigneeId: me.id,
  stateType: 'started',
  limit: 20,
});
```

"What did we complete in the last seven days?", every page of it:

```typescript
const filter: SearchIssuesInput = {
  teamKey: 'OMA',
  completedAt: { from: '-P7D' },
  limit: 50,
};

const completed: LinearIssue[] = [];
let page = await linear.searchIssues(filter);
completed.push(...page.issues);
while (page.nextCursor !== undefined) {
  page = await linear.searchIssues({ ...filter, cursor: page.nextCursor });
  completed.push(...page.issues);
}
```

"What is in the current cycle?":

```typescript
const current = (await linear.cycles(team.id)).find((c) => c.phase === 'current');
if (!current) throw new Error('team OMA has no cycle running');

const { issues } = await linear.searchIssues({ teamKey: 'OMA', cycleId: current.id });
```

Create an issue from free text:

```typescript
const created = await linear.createIssue({
  teamId: team.id,
  title: 'Login fails on Safari',
  description: 'Reported in the #support channel.\n\nSteps: …',
  priority: 2,
});
// created.identifier → 'OMA-31', created.url → deep link for the reply
```

## What this does not do

- ❌ **No delete and no archive.** Out of scope by decision, not by oversight.
- ❌ **No project, cycle, estimate or parent edits.** Projects and cycles can
  be read and filtered by. The editable set is exactly: state, assignee,
  priority, title, description, labels.
- ❌ **No documents, attachments, initiatives or customers.**
- ❌ **No Push.** The connection has no routes and claims no public paths;
  Linear cannot call into omadia through it.
- ❌ **No per-user identity.** Every call acts as the key's owner, so an issue
  created through omadia is attributed to that one person. Per-user attribution
  needs OAuth.
## Versioning

Adding a method or an optional input field is non-breaking and stays at
`linear.api@2`. Removing a method, renaming a field, or changing what a method
returns is a major event: bump to `linear.api@3` in `provides:` and in this
file, and expect every consumer's `requires:` to need the same bump.

`linear.api@2` differs from `linear.api@1` in one return type: `searchIssues`
answers with a `LinearIssuePage` where it answered with a `LinearIssue[]`.
Everything else that is new (`projects`, `cycles`, the added filter fields,
`project` and `cycle` on an issue) is an addition.
