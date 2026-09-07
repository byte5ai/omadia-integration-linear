import { strict as assert } from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import {
  createLinearClient,
  LINEAR_GRAPHQL_ENDPOINT,
  LinearApiError,
  LinearAuthError,
  LinearGraphQLError,
  LinearMutationError,
  LinearRateLimitError,
  type LinearClient,
} from '../src/client.js';

/**
 * The client is the only place in this package that talks to Linear, and it
 * never talks to the live API in a test — every case below drives a mocked
 * `ctx.http.fetch`. What that buys is exactly two things, and it is worth
 * being explicit about which: the REQUEST the client builds (endpoint, bare
 * auth header, query text, variables) and the way it maps a response back —
 * including the three failure shapes Linear actually produces. What it cannot
 * buy is agreement with Linear's schema; that is what the manual end-to-end
 * pass against the `omadia-dev` workspace is for.
 */

const API_KEY = 'lin_api_TESTKEY';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

interface Mock {
  calls: Call[];
  /** Queue one response per upcoming call, in order. */
  push(body: unknown, init?: { status?: number; headers?: Record<string, string> }): void;
  /** Queue a raw body — for the "upstream returned HTML" case. */
  pushRaw(body: string, init?: { status?: number; headers?: Record<string, string> }): void;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function createMock(): Mock {
  const calls: Call[] = [];
  const queue: Response[] = [];
  return {
    calls,
    push(body, init) {
      queue.push(
        new Response(JSON.stringify(body), {
          status: init?.status ?? 200,
          headers: { 'content-type': 'application/json', ...init?.headers },
        }),
      );
    },
    pushRaw(body, init) {
      queue.push(
        new Response(body, {
          status: init?.status ?? 200,
          headers: { 'content-type': 'text/html', ...init?.headers },
        }),
      );
    },
    async fetch(url, init) {
      calls.push({ url, init });
      const res = queue.shift();
      if (!res) throw new Error(`unexpected fetch to ${url} — no response queued`);
      return res;
    },
  };
}

/** The request body of the n-th call, decoded. */
function sentBody(mock: Mock, n = 0): { query: string; variables: Record<string, unknown> } {
  const call = mock.calls[n];
  assert.ok(call, `no call at index ${n}`);
  assert.equal(typeof call.init?.body, 'string');
  return JSON.parse(String(call.init?.body)) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

function sentHeaders(mock: Mock, n = 0): Record<string, string> {
  const call = mock.calls[n];
  assert.ok(call, `no call at index ${n}`);
  return (call.init?.headers ?? {}) as Record<string, string>;
}

let mock: Mock;
let client: LinearClient;

beforeEach(() => {
  mock = createMock();
  client = createLinearClient({ apiKey: API_KEY, fetch: (u, i) => mock.fetch(u, i) });
});

describe('request shape', () => {
  it('posts to the Linear GraphQL endpoint', async () => {
    mock.push({ data: { viewer: { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true } } });
    await client.viewer();

    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.url, LINEAR_GRAPHQL_ENDPOINT);
    assert.equal(mock.calls[0]?.init?.method, 'POST');
  });

  it('sends the personal API key bare, without a Bearer prefix', async () => {
    mock.push({ data: { viewer: { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true } } });
    await client.viewer();

    const headers = sentHeaders(mock);
    assert.equal(headers['Authorization'], API_KEY);
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('passes arguments as GraphQL variables rather than interpolating them', async () => {
    mock.push({ data: { issues: { nodes: [] } } });
    await client.searchIssues({ teamKey: 'OMA', stateType: 'started', assigneeId: 'u9', limit: 7 });

    const { query, variables } = sentBody(mock);
    assert.equal(variables['first'], 7);
    assert.deepEqual(variables['filter'], {
      team: { key: { eq: 'OMA' } },
      state: { type: { eq: 'started' } },
      assignee: { id: { eq: 'u9' } },
    });
    // The literals must not have been baked into the document.
    assert.ok(!query.includes('OMA'), 'team key leaked into the query text');
    assert.ok(!query.includes('u9'), 'assignee id leaked into the query text');
  });
});

describe('lookups', () => {
  it('maps teams', async () => {
    mock.push({
      data: { teams: { nodes: [{ id: 't1', key: 'OMA', name: 'Omadia' }] } },
    });

    assert.deepEqual(await client.teams(), [{ id: 't1', key: 'OMA', name: 'Omadia' }]);
  });

  it('narrows workflow states to one team and orders them by position', async () => {
    mock.push({
      data: {
        workflowStates: {
          nodes: [
            { id: 's2', name: 'Done', type: 'completed', position: 2, team: { id: 't1' } },
            { id: 's1', name: 'Todo', type: 'unstarted', position: 1, team: { id: 't1' } },
            { id: 's9', name: 'Other', type: 'unstarted', position: 1, team: { id: 't2' } },
          ],
        },
      },
    });

    assert.deepEqual(await client.workflowStates('t1'), [
      { id: 's1', name: 'Todo', type: 'unstarted', position: 1, teamId: 't1' },
      { id: 's2', name: 'Done', type: 'completed', position: 2, teamId: 't1' },
    ]);
  });

  it('matches users on name, display name and e-mail, case-insensitively', async () => {
    mock.push({
      data: {
        users: {
          nodes: [
            { id: 'u1', name: 'Ada Lovelace', displayName: 'ada', email: 'ada@example.com', active: true },
            { id: 'u2', name: 'Grace Hopper', displayName: 'grace', email: 'grace@example.com', active: true },
          ],
        },
      },
    });

    const hits = await client.users('LOVELACE');
    assert.deepEqual(hits.map((u) => u.id), ['u1']);
  });

  it('returns every user when no query is given', async () => {
    mock.push({
      data: {
        users: {
          nodes: [
            { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true },
            { id: 'u2', name: 'Grace', displayName: 'grace', email: null, active: false },
          ],
        },
      },
    });

    const hits = await client.users();
    assert.deepEqual(hits.map((u) => u.id), ['u1', 'u2']);
    assert.equal(hits[0]?.email, undefined);
    assert.equal(hits[1]?.active, false);
  });

  it('keeps workspace-wide labels when narrowing labels to a team', async () => {
    mock.push({
      data: {
        issueLabels: {
          nodes: [
            { id: 'l1', name: 'bug', team: { id: 't1' } },
            { id: 'l2', name: 'other-team', team: { id: 't2' } },
            { id: 'l3', name: 'workspace-wide', team: null },
          ],
        },
      },
    });

    assert.deepEqual(await client.labels('t1'), [
      { id: 'l1', name: 'bug', teamId: 't1' },
      { id: 'l3', name: 'workspace-wide', teamId: undefined },
    ]);
  });
});

const ISSUE_NODE = {
  id: 'i1',
  identifier: 'OMA-7',
  title: 'Login is broken',
  url: 'https://linear.app/omadia-dev/issue/OMA-7',
  priority: 2,
  priorityLabel: 'High',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-02T10:00:00.000Z',
  state: { id: 's1', name: 'Todo', type: 'unstarted' },
  assignee: { id: 'u1', name: 'Ada Lovelace', displayName: 'ada' },
  team: { id: 't1', key: 'OMA', name: 'Omadia' },
  labels: { nodes: [{ id: 'l1', name: 'bug' }] },
};

describe('issues', () => {
  it('maps a search hit into the flat issue shape', async () => {
    mock.push({ data: { issues: { nodes: [ISSUE_NODE] } } });

    const [issue] = await client.searchIssues({});
    assert.equal(issue?.identifier, 'OMA-7');
    assert.equal(issue?.title, 'Login is broken');
    assert.equal(issue?.priorityLabel, 'High');
    assert.deepEqual(issue?.state, { id: 's1', name: 'Todo', type: 'unstarted' });
    assert.deepEqual(issue?.assignee, { id: 'u1', name: 'Ada Lovelace', displayName: 'ada' });
    assert.deepEqual(issue?.team, { id: 't1', key: 'OMA', name: 'Omadia' });
    assert.deepEqual(issue?.labels, ['bug']);
  });

  it('reports an unassigned issue as undefined rather than null', async () => {
    mock.push({ data: { issues: { nodes: [{ ...ISSUE_NODE, assignee: null }] } } });

    const [issue] = await client.searchIssues({});
    assert.equal(issue?.assignee, undefined);
  });

  it('switches to full-text search when text is given, keeping the filters', async () => {
    mock.push({ data: { searchIssues: { nodes: [ISSUE_NODE] } } });
    await client.searchIssues({ text: 'login', teamKey: 'OMA' });

    const { query, variables } = sentBody(mock);
    assert.ok(query.includes('searchIssues'), 'expected the full-text root field');
    assert.equal(variables['term'], 'login');
    assert.deepEqual(variables['filter'], { team: { key: { eq: 'OMA' } } });
  });

  it('caps the result limit so one lookup cannot flood the model context', async () => {
    mock.push({ data: { issues: { nodes: [] } } });
    await client.searchIssues({ limit: 5000 });

    assert.equal(sentBody(mock).variables['first'], 100);
  });

  it('looks an issue key up by team key plus number', async () => {
    mock.push({ data: { issues: { nodes: [{ ...ISSUE_NODE, description: 'Steps', comments: { nodes: [] } }] } } });
    const issue = await client.getIssue('OMA-7');

    assert.deepEqual(sentBody(mock).variables['filter'], {
      team: { key: { eq: 'OMA' } },
      number: { eq: 7 },
    });
    assert.equal(issue?.description, 'Steps');
    assert.deepEqual(issue?.comments, []);
  });

  it('looks an opaque id up by id', async () => {
    mock.push({ data: { issues: { nodes: [] } } });
    await client.getIssue('9b1c-not-a-key');

    assert.deepEqual(sentBody(mock).variables['filter'], { id: { eq: '9b1c-not-a-key' } });
  });

  it('returns undefined for an issue that does not exist', async () => {
    mock.push({ data: { issues: { nodes: [] } } });

    assert.equal(await client.getIssue('OMA-999'), undefined);
  });

  it('maps comments, dropping the null author of a bot comment', async () => {
    mock.push({
      data: {
        issues: {
          nodes: [
            {
              ...ISSUE_NODE,
              description: null,
              comments: {
                nodes: [
                  {
                    id: 'c1',
                    body: 'On it',
                    url: 'https://linear.app/omadia-dev/issue/OMA-7#comment-c1',
                    createdAt: '2026-09-02T11:00:00.000Z',
                    user: { id: 'u1', name: 'Ada', displayName: 'ada' },
                  },
                  {
                    id: 'c2',
                    body: 'Automated',
                    url: 'https://linear.app/omadia-dev/issue/OMA-7#comment-c2',
                    createdAt: '2026-09-02T12:00:00.000Z',
                    user: null,
                  },
                ],
              },
            },
          ],
        },
      },
    });

    const issue = await client.getIssue('OMA-7');
    assert.equal(issue?.description, undefined);
    assert.deepEqual(issue?.comments.map((c) => c.author), ['Ada', undefined]);
  });
});

describe('writes', () => {
  it('sends only the fields the caller set on create', async () => {
    mock.push({ data: { issueCreate: { success: true, issue: ISSUE_NODE } } });
    const issue = await client.createIssue({ teamId: 't1', title: 'Login is broken' });

    assert.deepEqual(sentBody(mock).variables['input'], {
      teamId: 't1',
      title: 'Login is broken',
    });
    assert.equal(issue.identifier, 'OMA-7');
  });

  it('forwards every editable create field', async () => {
    mock.push({ data: { issueCreate: { success: true, issue: ISSUE_NODE } } });
    await client.createIssue({
      teamId: 't1',
      title: 'Login is broken',
      description: 'Steps',
      stateId: 's1',
      assigneeId: 'u1',
      priority: 2,
      labelIds: ['l1'],
    });

    assert.deepEqual(sentBody(mock).variables['input'], {
      teamId: 't1',
      title: 'Login is broken',
      description: 'Steps',
      stateId: 's1',
      assigneeId: 'u1',
      priority: 2,
      labelIds: ['l1'],
    });
  });

  it('sends the issue id beside a partial update input', async () => {
    mock.push({ data: { issueUpdate: { success: true, issue: ISSUE_NODE } } });
    await client.updateIssue('i1', { stateId: 's2' });

    const { variables } = sentBody(mock);
    assert.equal(variables['id'], 'i1');
    assert.deepEqual(variables['input'], { stateId: 's2' });
  });

  it('allows clearing the assignee with an explicit null', async () => {
    mock.push({ data: { issueUpdate: { success: true, issue: ISSUE_NODE } } });
    await client.updateIssue('i1', { assigneeId: null });

    assert.deepEqual(sentBody(mock).variables['input'], { assigneeId: null });
  });

  it('refuses an update that would change nothing', async () => {
    await assert.rejects(() => client.updateIssue('i1', {}), /no fields to update/i);
    assert.equal(mock.calls.length, 0, 'must not reach the network');
  });

  it('adds a comment', async () => {
    mock.push({
      data: {
        commentCreate: {
          success: true,
          comment: {
            id: 'c1',
            body: 'On it',
            url: 'https://linear.app/omadia-dev/issue/OMA-7#comment-c1',
            createdAt: '2026-09-02T11:00:00.000Z',
            user: { id: 'u1', name: 'Ada', displayName: 'ada' },
          },
        },
      },
    });

    const comment = await client.addComment('i1', 'On it');
    assert.deepEqual(sentBody(mock).variables['input'], { issueId: 'i1', body: 'On it' });
    assert.equal(comment.id, 'c1');
    assert.equal(comment.author, 'Ada');
  });

  it('treats success=false as a failed write, not a silent no-op', async () => {
    mock.push({ data: { issueCreate: { success: false, issue: null } } });

    await assert.rejects(
      () => client.createIssue({ teamId: 't1', title: 'x' }),
      (err: unknown) => {
        assert.ok(err instanceof LinearMutationError);
        assert.ok(err instanceof LinearApiError);
        assert.match(err.message, /issueCreate/);
        // The status is the one the response actually carried, not a constant
        // — INTEGRATION.md documents it as the upstream HTTP status.
        assert.equal(err.status, 200);
        return true;
      },
    );
  });

  it('reports the same failure for update and comment', async () => {
    mock.push({ data: { issueUpdate: { success: false, issue: null } } });
    await assert.rejects(
      () => client.updateIssue('i1', { stateId: 's2' }),
      (err: unknown) => err instanceof LinearMutationError && /issueUpdate/.test(err.message),
    );

    mock.push({ data: { commentCreate: { success: false, comment: null } } });
    await assert.rejects(
      () => client.addComment('i1', 'x'),
      (err: unknown) => err instanceof LinearMutationError && /commentCreate/.test(err.message),
    );
  });
});

describe('error mapping', () => {
  it('raises LinearAuthError on 401', async () => {
    mock.pushRaw('Unauthorized', { status: 401 });

    await assert.rejects(
      () => client.viewer(),
      (err: unknown) => {
        assert.ok(err instanceof LinearAuthError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  });

  it('raises LinearAuthError on a GraphQL authentication error behind HTTP 200', async () => {
    mock.push({
      errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }],
    });

    await assert.rejects(() => client.viewer(), (err: unknown) => err instanceof LinearAuthError);
  });

  it('raises LinearAuthError when the reason is in extensions.code instead of type', async () => {
    // Linear is not consistent about which extension field carries the
    // machine-readable reason. Reading only one of the two used to drop this
    // shape into the generic GraphQL bucket.
    mock.push({
      errors: [{ message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } }],
    });

    await assert.rejects(() => client.viewer(), (err: unknown) => err instanceof LinearAuthError);
  });

  it('raises LinearRateLimitError when the reason is in extensions.type instead of code', async () => {
    mock.push({ errors: [{ message: 'Slow down', extensions: { type: 'ratelimited' } }] });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => err instanceof LinearRateLimitError,
    );
  });

  it('raises LinearRateLimitError for the HTTP 400 + RATELIMITED shape', async () => {
    mock.push(
      {
        errors: [
          {
            message: 'Rate limit exceeded',
            extensions: { code: 'RATELIMITED', type: 'ratelimited' },
          },
        ],
      },
      { status: 400, headers: { 'x-ratelimit-requests-reset': '1789000000000' } },
    );

    await assert.rejects(
      () => client.searchIssues({}),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.status, 400);
        assert.equal(err.resetAt?.toISOString(), new Date(1789000000000).toISOString());
        return true;
      },
    );
  });

  it('raises LinearGraphQLError for any other errors[] payload, keeping the messages', async () => {
    mock.push({
      errors: [{ message: 'Field "nope" does not exist' }, { message: 'second problem' }],
    });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearGraphQLError);
        assert.equal(err.errors.length, 2);
        assert.match(err.message, /Field "nope" does not exist/);
        assert.match(err.message, /second problem/);
        return true;
      },
    );
  });

  it('raises LinearApiError on a non-2xx without a GraphQL body', async () => {
    mock.pushRaw('<html>502 Bad Gateway</html>', { status: 502 });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearApiError);
        assert.equal(err.status, 502);
        assert.match(String(err.body), /502 Bad Gateway/);
        return true;
      },
    );
  });

  it('raises LinearApiError when a 200 carries neither data nor errors', async () => {
    mock.pushRaw('not json at all');

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearApiError);
        assert.match(err.message, /could not be parsed/i);
        return true;
      },
    );
  });

  it('truncates a huge upstream body instead of carrying it around', async () => {
    mock.pushRaw('x'.repeat(10_000), { status: 500 });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearApiError);
        assert.ok((err.body?.length ?? 0) <= 1_100, `body was ${String(err.body?.length)} chars`);
        return true;
      },
    );
  });
});
