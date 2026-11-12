/**
 * The Linear connection's GraphQL client.
 *
 * Hand-written on purpose. `@linear/sdk` calls `globalThis.fetch` directly and
 * offers no injection point, so it would slip straight past the host's
 * outbound allow-list and rate limiter — the two guarantees `ctx.http` exists
 * to provide. This file therefore speaks GraphQL over an injected fetch and
 * carries no runtime dependency at all.
 *
 * Everything here is LLM-free and host-free: the only thing it needs from the
 * outside is a `fetch`. That is what makes it testable against a mock and what
 * keeps the tool layer (in `@omadia/agent-linear`) from having to know
 * anything about GraphQL.
 *
 * The exported surface is the Linear API capability's contract — see
 * INTEGRATION.md, which is the document consumers read.
 */

export const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';

/** Per-request cap on issues returned. A lookup feeds a model context. */
export const MAX_ISSUE_LIMIT = 100;
/** Used when the caller names no limit. */
export const DEFAULT_ISSUE_LIMIT = 25;
/** Comments read back with an issue detail. */
export const MAX_COMMENTS = 100;
/**
 * Page size for the four lookup queries. They are unpaginated on purpose:
 * teams, workflow states, users and labels are workspace-scale collections
 * (tens, not thousands), and a lookup that silently returned page 1 of many
 * would resolve a name to the wrong id. If a workspace ever outgrows this,
 * the queries need real pagination, not a bigger number.
 */
export const MAX_LOOKUP_NODES = 250;
/** Upstream body kept on an error. Enough to diagnose, small enough to log. */
const MAX_ERROR_BODY_CHARS = 1_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base for every failure this client raises. */
export class LinearApiError extends Error {
  /** Upstream HTTP status, or 0 when the request never got one. */
  public readonly status: number;
  /** Truncated upstream body, when there was one. */
  public readonly body: string | undefined;

  constructor(message: string, status: number, body?: string) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Which explicit refusal of the API key Linear answered with. The three
 * values are the host's connection-rejection causes, restated here so this
 * file needs no host import.
 *
 * - `http_401` — the answer came under HTTP 401.
 * - `http_403_auth` — HTTP 403 whose body names authentication itself. A 403
 *   that names anything else (a permission, a plan) is not a verdict on the
 *   key and stays a plain {@link LinearApiError}.
 * - `protocol_auth_failure` — an authentication error inside `errors[]` under
 *   any other status, HTTP 200 included.
 */
export type LinearAuthRejection = 'http_401' | 'http_403_auth' | 'protocol_auth_failure';

/**
 * Linear refused the API key: missing, revoked or malformed. Not retryable —
 * the operator has to paste a new key in the plugin's setup.
 */
export class LinearAuthError extends LinearApiError {
  /** The refusal Linear gave. What the connection status reports as its cause. */
  public readonly rejection: LinearAuthRejection;

  constructor(message: string, status: number, rejection: LinearAuthRejection, body?: string) {
    super(message, status, body);
    this.name = 'LinearAuthError';
    this.rejection = rejection;
  }
}

/**
 * Linear's request or complexity budget is spent. Linear answers with
 * HTTP 429, `RATELIMITED` in the error extensions and a `Retry-After` header.
 * Until 2026-11-05 the same body came under HTTP 400; that shape is still
 * recognised.
 */
export class LinearRateLimitError extends LinearApiError {
  /**
   * When to try again, if Linear said so: `Retry-After` counted from the
   * moment the answer arrived, otherwise the request budget's reset time.
   */
  public readonly resetAt: Date | undefined;

  constructor(message: string, status: number, resetAt: Date | undefined, body?: string) {
    super(message, status, body);
    this.name = 'LinearRateLimitError';
    this.resetAt = resetAt;
  }
}

export interface LinearGraphQLErrorEntry {
  readonly message: string;
  readonly extensions?: Record<string, unknown>;
}

/** Linear answered with `errors[]` for a reason other than auth or throttling. */
export class LinearGraphQLError extends LinearApiError {
  public readonly errors: readonly LinearGraphQLErrorEntry[];

  constructor(errors: readonly LinearGraphQLErrorEntry[], status: number, body?: string) {
    super(
      `linear: GraphQL error — ${errors.map((e) => e.message).join('; ')}`,
      status,
      body,
    );
    this.name = 'LinearGraphQLError';
    this.errors = errors;
  }
}

/**
 * A mutation came back `success: false`. Linear accepted the request and
 * declined the change, which is a different thing from a transport failure and
 * must never be reported to a user as "done".
 */
export class LinearMutationError extends LinearApiError {
  constructor(mutation: string, status: number) {
    super(`linear: ${mutation} reported success=false — nothing was changed`, status);
    this.name = 'LinearMutationError';
  }
}

/** What one GraphQL round trip yields: the payload plus the status it came under. */
interface GraphQLResult<T> {
  readonly data: T;
  readonly status: number;
}

// ---------------------------------------------------------------------------
// Domain shapes
// ---------------------------------------------------------------------------

/**
 * Linear's own workflow-state categories. "Closing" an issue means moving it
 * to a `completed` or `canceled` state; Linear has no close operation.
 */
export type LinearWorkflowStateType =
  | 'triage'
  | 'backlog'
  | 'unstarted'
  | 'started'
  | 'completed'
  | 'canceled';

export interface LinearUser {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly active: boolean;
}

export interface LinearTeam {
  readonly id: string;
  readonly key: string;
  readonly name: string;
}

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
  readonly type: LinearWorkflowStateType;
  readonly position: number;
  readonly teamId: string;
}

export interface LinearLabel {
  readonly id: string;
  readonly name: string;
  /** `undefined` for a workspace-wide label that belongs to no team. */
  readonly teamId: string | undefined;
}

export interface LinearIssueRef {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
}

export interface LinearIssue {
  readonly id: string;
  /** The key users say out loud, e.g. `OMA-7`. */
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  /** 0 none, 1 urgent, 2 high, 3 normal, 4 low — Linear's own scale. */
  readonly priority: number;
  readonly priorityLabel: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: { readonly id: string; readonly name: string; readonly type: LinearWorkflowStateType };
  readonly assignee: LinearIssueRef | undefined;
  readonly team: LinearTeam;
  /** Label names, in Linear's order. */
  readonly labels: readonly string[];
}

export interface LinearComment {
  readonly id: string;
  readonly body: string;
  readonly url: string;
  readonly createdAt: string;
  /** Display name of the author, `undefined` for an app-authored comment. */
  readonly author: string | undefined;
}

export interface LinearIssueDetail extends LinearIssue {
  readonly description: string | undefined;
  readonly comments: readonly LinearComment[];
}

export interface SearchIssuesInput {
  /** Team key as users write it, e.g. `OMA`. */
  readonly teamKey?: string;
  readonly stateType?: LinearWorkflowStateType;
  readonly assigneeId?: string;
  /** Free text. Switches the query to Linear's full-text search. */
  readonly text?: string;
  /** Clamped to {@link MAX_ISSUE_LIMIT}; defaults to {@link DEFAULT_ISSUE_LIMIT}. */
  readonly limit?: number;
}

export interface CreateIssueInput {
  readonly teamId: string;
  readonly title: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly assigneeId?: string;
  readonly priority?: number;
  readonly labelIds?: readonly string[];
}

/**
 * Every field optional — but at least one must be set, or the call is refused
 * before it reaches the network. `null` on `assigneeId` clears the assignee;
 * omitting it leaves the assignee alone.
 */
export interface UpdateIssueInput {
  readonly title?: string;
  readonly description?: string;
  readonly stateId?: string;
  readonly assigneeId?: string | null;
  readonly priority?: number;
  readonly labelIds?: readonly string[];
}

/**
 * The Linear API capability, published as `linear.api@1`.
 *
 * Reads are unconditional. The three writes mutate Linear immediately — the
 * prepared-write/commit flow that fronts them for users lives in the Linear
 * agent, not here, because this layer has no conversation to preview into.
 */
export interface LinearClient {
  /** The key's owner. Also what "assign it to me" resolves to. */
  viewer(): Promise<LinearUser>;
  teams(): Promise<LinearTeam[]>;
  /** Workflow states of one team, ordered by their position in the board. */
  workflowStates(teamId: string): Promise<LinearWorkflowState[]>;
  /** Workspace members; `query` matches name, display name or e-mail. */
  users(query?: string): Promise<LinearUser[]>;
  /** Labels of one team plus the workspace-wide ones, or all labels. */
  labels(teamId?: string): Promise<LinearLabel[]>;
  searchIssues(input: SearchIssuesInput): Promise<LinearIssue[]>;
  /** By key (`OMA-7`) or by id. `undefined` when there is no such issue. */
  getIssue(keyOrId: string): Promise<LinearIssueDetail | undefined>;
  createIssue(input: CreateIssueInput): Promise<LinearIssue>;
  updateIssue(id: string, input: UpdateIssueInput): Promise<LinearIssue>;
  addComment(issueId: string, body: string): Promise<LinearComment>;
}

/** The `ctx.http.fetch` shape, restated so this file needs no host import. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Told what each request to Linear says about the API key. The connection
 * uses it to keep its status current between two connection checks: a key
 * revoked in Linear is first seen by an ordinary request.
 *
 * A throw from either method is swallowed. The outcome of a request never
 * depends on its observer.
 */
export interface LinearConnectionObserver {
  /** Linear refused the key. */
  authRejected(rejection: LinearAuthRejection): void;
  /** Linear accepted the key and answered with data. */
  succeeded(): void;
}

export interface LinearClientOptions {
  /** Personal API key. Sent bare — Linear rejects a `Bearer` prefix. */
  readonly apiKey: string;
  /** Normally `ctx.http.fetch`, bound to the plugin's allow-list. */
  readonly fetch: FetchLike;
  /** See {@link LinearConnectionObserver}. */
  readonly observer?: LinearConnectionObserver;
  /** Clock for turning `Retry-After` into a point in time. Defaults to `Date.now`. */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/**
 * The selection set every issue-returning query shares. Kept as one string so
 * a field added for the agent's benefit lands in reads, search and both write
 * results at once — a mismatch there shows up as a preview that disagrees with
 * what the user sees in Linear afterwards.
 */
const ISSUE_FIELDS = `
    id
    identifier
    title
    url
    priority
    priorityLabel
    createdAt
    updatedAt
    state { id name type }
    assignee { id name displayName }
    team { id key name }
    labels(first: 50) { nodes { id name } }`;

const USER_FIELDS = 'id name displayName email active';
const COMMENT_FIELDS = 'id body url createdAt user { id name displayName }';

const Q_VIEWER = `query OmadiaLinearViewer { viewer { ${USER_FIELDS} } }`;

const Q_TEAMS = `query OmadiaLinearTeams($first: Int!) {
  teams(first: $first) { nodes { id key name } }
}`;

const Q_WORKFLOW_STATES = `query OmadiaLinearWorkflowStates($first: Int!) {
  workflowStates(first: $first) { nodes { id name type position team { id } } }
}`;

const Q_USERS = `query OmadiaLinearUsers($first: Int!) {
  users(first: $first) { nodes { ${USER_FIELDS} } }
}`;

const Q_LABELS = `query OmadiaLinearLabels($first: Int!) {
  issueLabels(first: $first) { nodes { id name team { id } } }
}`;

const Q_ISSUES = `query OmadiaLinearIssues($filter: IssueFilter, $first: Int!) {
  issues(filter: $filter, first: $first, orderBy: updatedAt) {
    nodes {${ISSUE_FIELDS}
    }
  }
}`;

const Q_SEARCH_ISSUES = `query OmadiaLinearSearchIssues($term: String!, $filter: IssueFilter, $first: Int!) {
  searchIssues(term: $term, filter: $filter, first: $first) {
    nodes {${ISSUE_FIELDS}
    }
  }
}`;

const Q_ISSUE_DETAIL = `query OmadiaLinearIssue($filter: IssueFilter, $comments: Int!) {
  issues(filter: $filter, first: 1) {
    nodes {${ISSUE_FIELDS}
      description
      comments(first: $comments) { nodes { ${COMMENT_FIELDS} } }
    }
  }
}`;

const M_ISSUE_CREATE = `mutation OmadiaLinearIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {${ISSUE_FIELDS}
    }
  }
}`;

const M_ISSUE_UPDATE = `mutation OmadiaLinearIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {${ISSUE_FIELDS}
    }
  }
}`;

const M_COMMENT_CREATE = `mutation OmadiaLinearCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
}`;

// ---------------------------------------------------------------------------
// Upstream shapes
// ---------------------------------------------------------------------------

/**
 * What the documents above select, restated as types. The cast from the
 * response's `data` to these is trusted precisely because the query text and
 * the shape live side by side in this file — the pairing is the guarantee, and
 * a schema drift surfaces as a GraphQL error, not as a silent mis-read.
 */
interface RawRef {
  id: string;
  name: string;
  displayName: string;
}

interface RawUser extends RawRef {
  email: string | null;
  active: boolean;
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  createdAt: string;
  updatedAt: string;
  state: { id: string; name: string; type: LinearWorkflowStateType };
  assignee: RawRef | null;
  team: LinearTeam;
  labels: { nodes: { id: string; name: string }[] };
}

interface RawComment {
  id: string;
  body: string;
  url: string;
  createdAt: string;
  user: RawRef | null;
}

interface RawIssueDetail extends RawIssue {
  description: string | null;
  comments: { nodes: RawComment[] };
}

interface GraphQLResponse {
  data?: unknown;
  errors?: LinearGraphQLErrorEntry[];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toUser(raw: RawUser): LinearUser {
  return {
    id: raw.id,
    name: raw.name,
    displayName: raw.displayName,
    email: raw.email ?? undefined,
    active: raw.active,
  };
}

function toRef(raw: RawRef): LinearIssueRef {
  return { id: raw.id, name: raw.name, displayName: raw.displayName };
}

function toIssue(raw: RawIssue): LinearIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    url: raw.url,
    priority: raw.priority,
    priorityLabel: raw.priorityLabel,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    state: raw.state,
    assignee: raw.assignee ? toRef(raw.assignee) : undefined,
    team: raw.team,
    labels: raw.labels.nodes.map((l) => l.name),
  };
}

function toComment(raw: RawComment): LinearComment {
  return {
    id: raw.id,
    body: raw.body,
    url: raw.url,
    createdAt: raw.createdAt,
    author: raw.user?.name ?? undefined,
  };
}

function toIssueDetail(raw: RawIssueDetail): LinearIssueDetail {
  return {
    ...toIssue(raw),
    description: raw.description ?? undefined,
    comments: raw.comments.nodes.map(toComment),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `OMA-7` — a team key followed by the issue number, as users write it. */
const ISSUE_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/;

/**
 * First element, or `undefined` for an empty list. A named helper rather than
 * `[0]` at the call site, per the package contract's rule against bare index
 * access — the usual answer there is Lodash's `_.first`, which this package
 * cannot reach without giving up its zero-runtime-dependency stance.
 */
function first<T>(items: readonly T[]): T | undefined {
  return items.length > 0 ? items[0] : undefined;
}

function truncate(body: string): string {
  return body.length <= MAX_ERROR_BODY_CHARS
    ? body
    : `${body.slice(0, MAX_ERROR_BODY_CHARS)}… (truncated)`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_ISSUE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ISSUE_LIMIT);
}

/**
 * Both classifiers read `code` AND `type`. Linear is not consistent about
 * which of the two carries the machine-readable reason, and checking only one
 * of them lets the other spelling fall through to a generic GraphQL error —
 * which is exactly the misclassification the typed errors exist to prevent.
 */
function extensionSays(
  errors: readonly LinearGraphQLErrorEntry[],
  needle: string,
): boolean {
  return errors.some((e) =>
    ['code', 'type'].some((field) =>
      String(e.extensions?.[field] ?? '')
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .includes(needle),
    ),
  );
}

function isRateLimited(errors: readonly LinearGraphQLErrorEntry[]): boolean {
  return extensionSays(errors, 'ratelimited');
}

function isAuthFailure(errors: readonly LinearGraphQLErrorEntry[]): boolean {
  return extensionSays(errors, 'authentication');
}

/**
 * Body markers of a 403 that refuses the credential rather than a permission,
 * a plan or a region. The host applies the same list to every integration; a
 * 403 that names none of them says nothing about the key.
 */
const AUTH_403_MARKERS = [
  'unauthenticated',
  'authentication',
  'invalid_token',
  'invalid api key',
  'invalid x-api-key',
];

/** The refusal of the key one answer carries, or `undefined` when it carries none. */
function authRejectionOf(
  status: number,
  bodyText: string,
  errors: readonly LinearGraphQLErrorEntry[] | undefined,
): LinearAuthRejection | undefined {
  if (status === 401) return 'http_401';
  if (status === 403) {
    const body = bodyText.toLowerCase();
    return AUTH_403_MARKERS.some((marker) => body.includes(marker)) ? 'http_403_auth' : undefined;
  }
  return errors !== undefined && isAuthFailure(errors) ? 'protocol_auth_failure' : undefined;
}

/**
 * `Retry-After` first: it is the wait Linear asks for, in seconds, and counts
 * from the moment the answer arrived. An HTTP date is accepted as well, since
 * the header allows both. Without the header the request budget's reset time
 * (epoch milliseconds) is the nearest thing Linear sends.
 */
function readResetAt(res: Response, now: number): Date | undefined {
  const retryAfter = res.headers.get('retry-after')?.trim();
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) {
      return new Date(now + Math.ceil(Number(retryAfter) * 1_000));
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return new Date(at);
  }

  const raw = res.headers.get('x-ratelimit-requests-reset');
  if (!raw) return undefined;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : undefined;
}

/**
 * Drop the keys the caller left unset, so a partial update sends only what it
 * means to change. `null` survives — it is how Linear clears a field, and
 * conflating it with "not mentioned" would silently ignore an unassign.
 */
function withoutUndefined<T extends Record<string, unknown>>(
  input: T,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export function createLinearClient(opts: LinearClientOptions): LinearClient {
  const now = opts.now ?? Date.now;

  /** Tell the observer; whatever it does stays out of the request's outcome. */
  function tell(notify: (observer: LinearConnectionObserver) => void): void {
    if (opts.observer === undefined) return;
    try {
      notify(opts.observer);
    } catch {
      // Swallowed on purpose: see LinearConnectionObserver.
    }
  }

  /**
   * One request, one place where an upstream answer becomes either data or a
   * typed error. The order of the checks is the classification:
   *
   * 1. Throttling — HTTP 429 whatever the body says, or `RATELIMITED` in the
   *    extensions under any status (the shape Linear used under HTTP 400).
   * 2. A refused key — see {@link LinearAuthRejection}. It can arrive under
   *    HTTP 200, which is why `errors[]` is read before the status decides.
   * 3. Any other `errors[]`, then any other non-2xx.
   */
  async function request<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQLResult<T>> {
    const res = await opts.fetch(LINEAR_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        // Bare, no `Bearer` — that is the personal-API-key convention, and
        // Linear answers a prefixed key with an authentication error.
        Authorization: opts.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let payload: GraphQLResponse | undefined;
    try {
      payload = JSON.parse(text) as GraphQLResponse;
    } catch {
      payload = undefined;
    }

    const errors = payload?.errors && payload.errors.length > 0 ? payload.errors : undefined;
    const detail = first(errors ?? [])?.message ?? `HTTP ${String(res.status)}`;

    if (res.status === 429 || (errors !== undefined && isRateLimited(errors))) {
      throw new LinearRateLimitError(
        `linear: rate limit or complexity budget exceeded — ${detail}`,
        res.status,
        readResetAt(res, now()),
        truncate(text),
      );
    }

    const rejection = authRejectionOf(res.status, text, errors);
    if (rejection !== undefined) {
      tell((observer) => {
        observer.authRejected(rejection);
      });
      throw new LinearAuthError(
        `linear: API key rejected — ${detail}`,
        res.status,
        rejection,
        truncate(text),
      );
    }

    if (errors !== undefined) {
      throw new LinearGraphQLError(errors, res.status, truncate(text));
    }

    if (!res.ok) {
      throw new LinearApiError(`linear: HTTP ${String(res.status)}`, res.status, truncate(text));
    }

    if (payload === undefined || payload.data === undefined || payload.data === null) {
      throw new LinearApiError(
        'linear: response could not be parsed as a GraphQL payload',
        res.status,
        truncate(text),
      );
    }

    // The envelope is checked above; only the FIELD types inside `data` are
    // trusted, and they are trusted because the query text that pins the
    // selection set lives in this same file next to the shape it produces.
    // This is a deliberate deviation from the package contract's "unknown +
    // Zod-parse at external payloads" rule: mirroring every selection in a Zod
    // schema would add a runtime dependency to a package whose whole point is
    // having none, for drift that a removed field already surfaces as a
    // GraphQL error. The residual risk is a field whose TYPE changed under a
    // name that stayed — worth revisiting if that ever bites.
    tell((observer) => {
      observer.succeeded();
    });
    return { data: payload.data as T, status: res.status };
  }

  /**
   * Unwrap a mutation payload. All three writes share this: Linear answers a
   * declined change with `success: false` and HTTP 200, and reporting that to
   * a user as done is the one failure mode a write layer must not have.
   */
  function unwrapMutation<T>(
    result: GraphQLResult<{ success: boolean } & Record<string, unknown>>,
    mutation: string,
    value: T | null,
  ): T {
    if (!result.data.success || value === null) {
      throw new LinearMutationError(mutation, result.status);
    }
    return value;
  }

  /** Server-side issue filter, built from the parts the caller supplied. */
  function issueFilter(input: SearchIssuesInput): Record<string, unknown> | undefined {
    const filter: Record<string, unknown> = {};
    if (input.teamKey !== undefined) filter['team'] = { key: { eq: input.teamKey } };
    if (input.stateType !== undefined) filter['state'] = { type: { eq: input.stateType } };
    if (input.assigneeId !== undefined) filter['assignee'] = { id: { eq: input.assigneeId } };
    return Object.keys(filter).length > 0 ? filter : undefined;
  }

  return {
    async viewer(): Promise<LinearUser> {
      const { data } = await request<{ viewer: RawUser }>(Q_VIEWER, {});
      return toUser(data.viewer);
    },

    async teams(): Promise<LinearTeam[]> {
      const { data } = await request<{ teams: { nodes: LinearTeam[] } }>(Q_TEAMS, {
        first: MAX_LOOKUP_NODES,
      });
      return data.teams.nodes;
    },

    async workflowStates(teamId: string): Promise<LinearWorkflowState[]> {
      // Filtered here rather than server-side: `WorkflowStateFilter` is one
      // more piece of Linear's schema to be wrong about, and a workspace has
      // few enough states that fetching them all costs nothing.
      const { data } = await request<{
        workflowStates: {
          nodes: {
            id: string;
            name: string;
            type: LinearWorkflowStateType;
            position: number;
            team: { id: string };
          }[];
        };
      }>(Q_WORKFLOW_STATES, { first: MAX_LOOKUP_NODES });

      return data.workflowStates.nodes
        .filter((s) => s.team.id === teamId)
        .map((s) => ({
          id: s.id,
          name: s.name,
          type: s.type,
          position: s.position,
          teamId: s.team.id,
        }))
        .sort((a, b) => a.position - b.position);
    },

    async users(query?: string): Promise<LinearUser[]> {
      const { data } = await request<{ users: { nodes: RawUser[] } }>(Q_USERS, {
        first: MAX_LOOKUP_NODES,
      });
      const users = data.users.nodes.map(toUser);
      if (query === undefined || query.trim() === '') return users;

      const needle = query.trim().toLowerCase();
      return users.filter((u) =>
        [u.name, u.displayName, u.email ?? ''].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      );
    },

    async labels(teamId?: string): Promise<LinearLabel[]> {
      const { data } = await request<{
        issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] };
      }>(Q_LABELS, { first: MAX_LOOKUP_NODES });

      const labels = data.issueLabels.nodes.map((l) => ({
        id: l.id,
        name: l.name,
        teamId: l.team?.id ?? undefined,
      }));
      if (teamId === undefined) return labels;
      // Workspace-wide labels (no team) are usable on every team's issues, so
      // narrowing to a team must keep them.
      return labels.filter((l) => l.teamId === teamId || l.teamId === undefined);
    },

    async searchIssues(input: SearchIssuesInput): Promise<LinearIssue[]> {
      const limit = clampLimit(input.limit);
      const filter = issueFilter(input);
      const text = input.text?.trim();

      if (text !== undefined && text !== '') {
        const { data } = await request<{ searchIssues: { nodes: RawIssue[] } }>(Q_SEARCH_ISSUES, {
          term: text,
          filter,
          first: limit,
        });
        return data.searchIssues.nodes.map(toIssue);
      }

      const { data } = await request<{ issues: { nodes: RawIssue[] } }>(Q_ISSUES, {
        filter,
        first: limit,
      });
      return data.issues.nodes.map(toIssue);
    },

    async getIssue(keyOrId: string): Promise<LinearIssueDetail | undefined> {
      // Both paths go through the same `issues(filter:)` query. Resolving a
      // key as team-key plus number is deterministic, and an id that matches
      // nothing comes back as an empty node list — so "no such issue" is a
      // value here, never an error to be pattern-matched out of a message.
      const match = ISSUE_KEY_PATTERN.exec(keyOrId.trim());
      const filter =
        match !== null
          ? { team: { key: { eq: match[1] } }, number: { eq: Number(match[2]) } }
          : { id: { eq: keyOrId.trim() } };

      const { data } = await request<{ issues: { nodes: RawIssueDetail[] } }>(Q_ISSUE_DETAIL, {
        filter,
        comments: MAX_COMMENTS,
      });
      const node = first(data.issues.nodes);
      return node === undefined ? undefined : toIssueDetail(node);
    },

    async createIssue(input: CreateIssueInput): Promise<LinearIssue> {
      const result = await request<{
        issueCreate: { success: boolean; issue: RawIssue | null };
      }>(M_ISSUE_CREATE, { input: withoutUndefined({ ...input }) });

      return toIssue(
        unwrapMutation(
          { data: result.data.issueCreate, status: result.status },
          'issueCreate',
          result.data.issueCreate.issue,
        ),
      );
    },

    async updateIssue(id: string, input: UpdateIssueInput): Promise<LinearIssue> {
      const patch = withoutUndefined({ ...input });
      if (Object.keys(patch).length === 0) {
        // Refused before the network: an empty patch would come back
        // `success: true` and be reported to the user as a change that
        // happened, which is the one answer that must never be wrong.
        throw new LinearApiError('linear: no fields to update', 0);
      }

      const result = await request<{
        issueUpdate: { success: boolean; issue: RawIssue | null };
      }>(M_ISSUE_UPDATE, { id, input: patch });

      return toIssue(
        unwrapMutation(
          { data: result.data.issueUpdate, status: result.status },
          'issueUpdate',
          result.data.issueUpdate.issue,
        ),
      );
    },

    async addComment(issueId: string, body: string): Promise<LinearComment> {
      const result = await request<{
        commentCreate: { success: boolean; comment: RawComment | null };
      }>(M_COMMENT_CREATE, { input: { issueId, body } });

      return toComment(
        unwrapMutation(
          { data: result.data.commentCreate, status: result.status },
          'commentCreate',
          result.data.commentCreate.comment,
        ),
      );
    },
  };
}
