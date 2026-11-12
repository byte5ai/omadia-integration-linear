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
  LOOKUP_PAGE_SIZE,
  MAX_LOOKUP_NODES,
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

/**
 * One page of a connection as Linear sends it. With `next`, the page says
 * that another follows and names the cursor to fetch it with.
 */
function connection(nodes: readonly unknown[], next?: string): unknown {
  return { nodes, pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null } };
}

/** The fixed "now" the client is given, so a `Retry-After` wait has a known end. */
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);

let mock: Mock;
let client: LinearClient;
/** What the client told its observer, in order. */
let observed: string[];

beforeEach(() => {
  mock = createMock();
  observed = [];
  client = createLinearClient({
    apiKey: API_KEY,
    fetch: (u, i) => mock.fetch(u, i),
    now: () => NOW,
    observer: {
      authRejected: (rejection) => {
        observed.push(`rejected:${rejection}`);
      },
      succeeded: () => {
        observed.push('succeeded');
      },
    },
  });
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
    mock.push({ data: { issues: connection([]) } });
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
      data: { teams: connection([{ id: 't1', key: 'OMA', name: 'Omadia' }]) },
    });

    assert.deepEqual(await client.teams(), [{ id: 't1', key: 'OMA', name: 'Omadia' }]);
  });

  it('narrows workflow states to one team and orders them by position', async () => {
    mock.push({
      data: {
        workflowStates: connection([
          { id: 's2', name: 'Done', type: 'completed', position: 2, team: { id: 't1' } },
          { id: 's1', name: 'Todo', type: 'unstarted', position: 1, team: { id: 't1' } },
          { id: 's9', name: 'Other', type: 'unstarted', position: 1, team: { id: 't2' } },
        ]),
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
        users: connection([
          { id: 'u1', name: 'Ada Lovelace', displayName: 'ada', email: 'ada@example.com', active: true },
          { id: 'u2', name: 'Grace Hopper', displayName: 'grace', email: 'grace@example.com', active: true },
        ]),
      },
    });

    const hits = await client.users('LOVELACE');
    assert.deepEqual(hits.map((u) => u.id), ['u1']);
  });

  it('returns every user when no query is given', async () => {
    mock.push({
      data: {
        users: connection([
          { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true },
          { id: 'u2', name: 'Grace', displayName: 'grace', email: null, active: false },
        ]),
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
        issueLabels: connection([
          { id: 'l1', name: 'bug', team: { id: 't1' } },
          { id: 'l2', name: 'other-team', team: { id: 't2' } },
          { id: 'l3', name: 'workspace-wide', team: null },
        ]),
      },
    });

    assert.deepEqual(await client.labels('t1'), [
      { id: 'l1', name: 'bug', teamId: 't1' },
      { id: 'l3', name: 'workspace-wide', teamId: undefined },
    ]);
  });

  it('maps projects, with their status and dates', async () => {
    mock.push({
      data: {
        projects: connection([
          {
            id: 'p1',
            name: 'Mobile app',
            url: 'https://linear.app/omadia-dev/project/mobile-app-1',
            status: { name: 'In Progress', type: 'started' },
            startDate: '2026-10-01',
            targetDate: null,
          },
        ]),
      },
    });

    assert.deepEqual(await client.projects(), [
      {
        id: 'p1',
        name: 'Mobile app',
        url: 'https://linear.app/omadia-dev/project/mobile-app-1',
        status: { name: 'In Progress', type: 'started' },
        startDate: '2026-10-01',
        targetDate: undefined,
      },
    ]);
  });

  it('asks Linear for the cycles of one team and orders them by number', async () => {
    const cycle = (number: number, flags: Record<string, boolean>, name: string | null = null) => ({
      id: `c${String(number)}`,
      number,
      name,
      startsAt: `2026-11-${String(number).padStart(2, '0')}T00:00:00.000Z`,
      endsAt: `2026-11-${String(number + 1).padStart(2, '0')}T00:00:00.000Z`,
      isActive: false,
      isNext: false,
      isPrevious: false,
      isFuture: false,
      ...flags,
    });
    mock.push({
      data: {
        cycles: connection([
          cycle(15, { isFuture: true }),
          cycle(13, { isActive: true }, 'Launch'),
          cycle(11, {}),
          // Linear sets both flags on the neighbours of today.
          cycle(14, { isNext: true, isFuture: true }),
          cycle(12, { isPrevious: true }),
        ]),
      },
    });

    const cycles = await client.cycles('t1');
    assert.deepEqual(sentBody(mock).variables['filter'], { team: { id: { eq: 't1' } } });
    assert.deepEqual(
      cycles.map((c) => [c.number, c.phase]),
      [
        [11, 'past'],
        [12, 'previous'],
        [13, 'current'],
        [14, 'next'],
        [15, 'future'],
      ],
    );
    assert.equal(cycles[2]?.name, 'Launch');
    assert.equal(cycles[0]?.name, undefined);
    assert.equal(cycles[0]?.teamId, 't1');
  });
});

describe('lookup pagination', () => {
  const user = (n: number) => ({
    id: `u${String(n)}`,
    name: `Member ${String(n)}`,
    displayName: `member${String(n)}`,
    email: null,
    active: true,
  });
  const usersFrom = (start: number, count: number) =>
    Array.from({ length: count }, (_, i) => user(start + i));

  it('asks for the first page without a cursor', async () => {
    mock.push({ data: { teams: connection([]) } });
    await client.teams();

    const { variables } = sentBody(mock);
    assert.equal(variables['first'], LOOKUP_PAGE_SIZE);
    assert.ok(!('after' in variables), 'the first page must not name a cursor');
  });

  it('finds a name that only a later page carries', async () => {
    mock.push({ data: { users: connection(usersFrom(0, LOOKUP_PAGE_SIZE), 'cursor-1') } });
    mock.push({ data: { users: connection(usersFrom(LOOKUP_PAGE_SIZE, 30)) } });

    const hits = await client.users('Member 262');
    assert.deepEqual(hits.map((u) => u.id), ['u262']);
    assert.equal(mock.calls.length, 2);
    assert.equal(sentBody(mock, 1).variables['after'], 'cursor-1');
  });

  it('follows the cursor through every lookup', async () => {
    const lookups: [string, () => Promise<readonly { id: string }[]>, (id: string) => unknown][] = [
      ['teams', () => client.teams(), (id) => ({ id, key: id, name: id })],
      [
        'workflowStates',
        () => client.workflowStates('t1'),
        (id) => ({ id, name: id, type: 'started', position: 1, team: { id: 't1' } }),
      ],
      ['issueLabels', () => client.labels('t1'), (id) => ({ id, name: id, team: null })],
      [
        'projects',
        () => client.projects(),
        (id) => ({
          id,
          name: id,
          url: `https://linear.app/p/${id}`,
          status: { name: 'Planned', type: 'planned' },
          startDate: null,
          targetDate: null,
        }),
      ],
      [
        'cycles',
        () => client.cycles('t1'),
        (id) => ({
          id,
          number: id === 'first' ? 1 : 2,
          name: null,
          startsAt: '2026-11-01T00:00:00.000Z',
          endsAt: '2026-11-08T00:00:00.000Z',
          isActive: false,
          isNext: false,
          isPrevious: false,
          isFuture: false,
        }),
      ],
    ];

    for (const [root, lookup, node] of lookups) {
      const before = mock.calls.length;
      mock.push({ data: { [root]: connection([node('first')], 'cursor-1') } });
      mock.push({ data: { [root]: connection([node('second')]) } });

      const records = await lookup();
      assert.deepEqual(records.map((r) => r.id), ['first', 'second'], root);
      assert.equal(sentBody(mock, before + 1).variables['after'], 'cursor-1', root);
    }
  });

  it('sends the team filter with every page of cycles', async () => {
    mock.push({ data: { cycles: connection([], 'cursor-1') } });
    mock.push({ data: { cycles: connection([]) } });
    await client.cycles('t1');

    for (const n of [0, 1]) {
      assert.deepEqual(sentBody(mock, n).variables['filter'], { team: { id: { eq: 't1' } } });
    }
  });

  it('fails instead of answering with a part of an oversized collection', async () => {
    const pages = MAX_LOOKUP_NODES / LOOKUP_PAGE_SIZE;
    for (let n = 0; n < pages; n += 1) {
      mock.push({
        data: { users: connection(usersFrom(n * LOOKUP_PAGE_SIZE, LOOKUP_PAGE_SIZE), `cursor-${String(n)}`) },
      });
    }

    await assert.rejects(
      () => client.users('Member 3'),
      (err: unknown) => {
        assert.ok(err instanceof LinearApiError);
        assert.match(err.message, /more than 5000 records/);
        return true;
      },
    );
    assert.equal(mock.calls.length, pages, 'must stop asking at the bound');
  });

  it('returns a collection that ends exactly at the bound', async () => {
    const pages = MAX_LOOKUP_NODES / LOOKUP_PAGE_SIZE;
    for (let n = 0; n < pages; n += 1) {
      const last = n === pages - 1;
      mock.push({
        data: {
          users: connection(
            usersFrom(n * LOOKUP_PAGE_SIZE, LOOKUP_PAGE_SIZE),
            last ? undefined : `cursor-${String(n)}`,
          ),
        },
      });
    }

    assert.equal((await client.users()).length, MAX_LOOKUP_NODES);
  });

  it('fails when a page announces a successor and names no cursor', async () => {
    mock.push({
      data: { teams: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } },
    });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => err instanceof LinearApiError && /without a cursor/.test(err.message),
    );
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
  project: null,
  cycle: null,
};

describe('issues', () => {
  it('maps a search hit into the flat issue shape', async () => {
    mock.push({ data: { issues: connection([ISSUE_NODE]) } });

    const [issue] = (await client.searchIssues({})).issues;
    assert.equal(issue?.identifier, 'OMA-7');
    assert.equal(issue?.title, 'Login is broken');
    assert.equal(issue?.priorityLabel, 'High');
    assert.deepEqual(issue?.state, { id: 's1', name: 'Todo', type: 'unstarted' });
    assert.deepEqual(issue?.assignee, { id: 'u1', name: 'Ada Lovelace', displayName: 'ada' });
    assert.deepEqual(issue?.team, { id: 't1', key: 'OMA', name: 'Omadia' });
    assert.deepEqual(issue?.labels, ['bug']);
  });

  it('maps the project and the cycle of an issue that has them', async () => {
    mock.push({
      data: {
        issues: connection([
          {
            ...ISSUE_NODE,
            project: { id: 'p1', name: 'Mobile app' },
            cycle: { id: 'c12', number: 12, name: null },
          },
        ]),
      },
    });

    const [issue] = (await client.searchIssues({})).issues;
    assert.deepEqual(issue?.project, { id: 'p1', name: 'Mobile app' });
    assert.deepEqual(issue?.cycle, { id: 'c12', number: 12, name: undefined });
  });

  it('reports an issue without project and cycle as undefined for both', async () => {
    mock.push({ data: { issues: connection([ISSUE_NODE]) } });

    const [issue] = (await client.searchIssues({})).issues;
    assert.equal(issue?.project, undefined);
    assert.equal(issue?.cycle, undefined);
  });

  it('selects project and cycle wherever it selects an issue', async () => {
    mock.push({ data: { issues: connection([]) } });
    await client.searchIssues({});
    mock.push({ data: { searchIssues: connection([]) } });
    await client.searchIssues({ text: 'login' });
    mock.push({ data: { issues: { nodes: [] } } });
    await client.getIssue('OMA-7');
    mock.push({ data: { issueCreate: { success: true, issue: ISSUE_NODE } } });
    await client.createIssue({ teamId: 't1', title: 'x' });
    mock.push({ data: { issueUpdate: { success: true, issue: ISSUE_NODE } } });
    await client.updateIssue('i1', { stateId: 's2' });

    for (let n = 0; n < mock.calls.length; n += 1) {
      const { query } = sentBody(mock, n);
      assert.match(query, /project \{ id name \}/, `request ${String(n)}`);
      assert.match(query, /cycle \{ id number name \}/, `request ${String(n)}`);
    }
  });

  it('reports an unassigned issue as undefined rather than null', async () => {
    mock.push({ data: { issues: connection([{ ...ISSUE_NODE, assignee: null }]) } });

    const [issue] = (await client.searchIssues({})).issues;
    assert.equal(issue?.assignee, undefined);
  });

  it('switches to full-text search when text is given, keeping the filters', async () => {
    mock.push({ data: { searchIssues: connection([ISSUE_NODE]) } });
    await client.searchIssues({ text: 'login', teamKey: 'OMA' });

    const { query, variables } = sentBody(mock);
    assert.ok(query.includes('searchIssues'), 'expected the full-text root field');
    assert.equal(variables['term'], 'login');
    assert.deepEqual(variables['filter'], { team: { key: { eq: 'OMA' } } });
  });

  it('sends every filter in the shape Linear\'s issue filter takes', async () => {
    mock.push({ data: { issues: connection([]) } });
    await client.searchIssues({
      teamKey: 'OMA',
      stateType: 'triage',
      assigneeId: 'u1',
      creatorId: 'u2',
      labelId: 'l1',
      priority: 1,
      projectId: 'p1',
      cycleId: 'c12',
      createdAt: { from: '2026-11-02', before: '2026-11-09' },
      updatedAt: { from: '-P7D' },
      completedAt: { before: '2026-11-09T12:00:00.000Z' },
    });

    assert.deepEqual(sentBody(mock).variables['filter'], {
      team: { key: { eq: 'OMA' } },
      state: { type: { eq: 'triage' } },
      assignee: { id: { eq: 'u1' } },
      creator: { id: { eq: 'u2' } },
      labels: { some: { id: { eq: 'l1' } } },
      priority: { eq: 1 },
      project: { id: { eq: 'p1' } },
      cycle: { id: { eq: 'c12' } },
      createdAt: { gte: '2026-11-02', lt: '2026-11-09' },
      updatedAt: { gte: '-P7D' },
      completedAt: { lt: '2026-11-09T12:00:00.000Z' },
    });
  });

  it('filters by priority 0, which is a value and not an absence', async () => {
    mock.push({ data: { issues: connection([]) } });
    await client.searchIssues({ priority: 0 });

    assert.deepEqual(sentBody(mock).variables['filter'], { priority: { eq: 0 } });
  });

  it('sends no filter for a search that names none, an empty time span included', async () => {
    mock.push({ data: { issues: connection([]) } });
    await client.searchIssues({ createdAt: {} });

    assert.ok(!('filter' in sentBody(mock).variables));
  });

  it('applies the filters to a full-text search as well', async () => {
    mock.push({ data: { searchIssues: connection([]) } });
    await client.searchIssues({ text: 'login', labelId: 'l1', completedAt: { from: '-P7D' } });

    assert.deepEqual(sentBody(mock).variables['filter'], {
      labels: { some: { id: { eq: 'l1' } } },
      completedAt: { gte: '-P7D' },
    });
  });

  it('says that a page is the last one', async () => {
    mock.push({ data: { issues: connection([ISSUE_NODE]) } });

    const page = await client.searchIssues({});
    assert.equal(page.issues.length, 1);
    assert.equal(page.nextCursor, undefined);
    assert.ok(!('after' in sentBody(mock).variables), 'the first page must not name a cursor');
  });

  it('hands out the cursor of the next page, and fetches that page with it', async () => {
    mock.push({ data: { issues: connection([ISSUE_NODE], 'cursor-1') } });
    const first = await client.searchIssues({ teamKey: 'OMA', limit: 1 });
    assert.equal(first.nextCursor, 'cursor-1');

    mock.push({ data: { issues: connection([{ ...ISSUE_NODE, identifier: 'OMA-8' }]) } });
    const second = await client.searchIssues({ teamKey: 'OMA', limit: 1, cursor: 'cursor-1' });

    const { variables } = sentBody(mock, 1);
    assert.equal(variables['after'], 'cursor-1');
    assert.deepEqual(variables['filter'], { team: { key: { eq: 'OMA' } } });
    assert.deepEqual(second.issues.map((i) => i.identifier), ['OMA-8']);
    assert.equal(second.nextCursor, undefined);
  });

  it('pages a full-text search the same way', async () => {
    mock.push({ data: { searchIssues: connection([ISSUE_NODE], 'cursor-1') } });
    const first = await client.searchIssues({ text: 'login' });
    assert.equal(first.nextCursor, 'cursor-1');

    mock.push({ data: { searchIssues: connection([]) } });
    await client.searchIssues({ text: 'login', cursor: 'cursor-1' });
    assert.equal(sentBody(mock, 1).variables['after'], 'cursor-1');
  });

  it('fails when a search page announces a successor and names no cursor', async () => {
    mock.push({
      data: { issues: { nodes: [ISSUE_NODE], pageInfo: { hasNextPage: true, endCursor: null } } },
    });

    await assert.rejects(
      () => client.searchIssues({}),
      (err: unknown) => err instanceof LinearApiError && /without a cursor/.test(err.message),
    );
  });

  it('caps the result limit so one lookup cannot flood the model context', async () => {
    mock.push({ data: { issues: connection([]) } });
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
        assert.equal(err.rejection, 'http_401');
        return true;
      },
    );
  });

  it('names 401 as the refusal even when the body carries a GraphQL authentication error', async () => {
    mock.push(
      { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
      { status: 401 },
    );

    await assert.rejects(
      () => client.viewer(),
      (err: unknown) => {
        assert.ok(err instanceof LinearAuthError);
        assert.equal(err.rejection, 'http_401');
        assert.match(err.message, /Authentication required/);
        return true;
      },
    );
  });

  it('raises LinearAuthError on a GraphQL authentication error behind HTTP 200', async () => {
    mock.push({
      errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }],
    });

    await assert.rejects(
      () => client.viewer(),
      (err: unknown) => {
        assert.ok(err instanceof LinearAuthError);
        assert.equal(err.rejection, 'protocol_auth_failure');
        return true;
      },
    );
  });

  it('raises LinearAuthError on a 403 whose body names authentication', async () => {
    mock.pushRaw('{"error":"Invalid API key"}', { status: 403 });

    await assert.rejects(
      () => client.viewer(),
      (err: unknown) => {
        assert.ok(err instanceof LinearAuthError);
        assert.equal(err.status, 403);
        assert.equal(err.rejection, 'http_403_auth');
        return true;
      },
    );
  });

  it('keeps a 403 that names no authentication a plain API error', async () => {
    // A 403 for a permission, a plan or a region is not a verdict on the key.
    mock.pushRaw('{"error":"not available in your region"}', { status: 403 });

    await assert.rejects(
      () => client.viewer(),
      (err: unknown) => {
        assert.ok(err instanceof LinearApiError);
        assert.ok(!(err instanceof LinearAuthError));
        assert.equal(err.status, 403);
        return true;
      },
    );
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

  it('raises LinearRateLimitError for HTTP 429 with the RATELIMITED body', async () => {
    mock.push(
      {
        errors: [
          {
            message: 'Rate limit exceeded',
            extensions: { code: 'RATELIMITED', type: 'ratelimited' },
          },
        ],
      },
      { status: 429, headers: { 'retry-after': '30' } },
    );

    await assert.rejects(
      () => client.searchIssues({}),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.status, 429);
        assert.match(err.message, /Rate limit exceeded/);
        assert.equal(err.resetAt?.getTime(), NOW + 30_000);
        return true;
      },
    );
  });

  it('raises LinearRateLimitError for HTTP 429 without a parseable body', async () => {
    mock.pushRaw('<html>Too Many Requests</html>', { status: 429, headers: { 'retry-after': '12' } });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.status, 429);
        assert.match(err.message, /HTTP 429/);
        assert.equal(err.resetAt?.getTime(), NOW + 12_000);
        return true;
      },
    );
  });

  it('raises LinearRateLimitError for HTTP 429 whose errors[] names no rate limit', async () => {
    mock.push({ errors: [{ message: 'Too many requests' }] }, { status: 429 });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => err instanceof LinearRateLimitError,
    );
  });

  it('prefers Retry-After over the request budget reset header', async () => {
    mock.push(
      { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      { status: 429, headers: { 'retry-after': '5', 'x-ratelimit-requests-reset': '1789000000000' } },
    );

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.resetAt?.getTime(), NOW + 5_000);
        return true;
      },
    );
  });

  it('falls back to the request budget reset header when Retry-After is absent', async () => {
    mock.push(
      { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      { status: 429, headers: { 'x-ratelimit-requests-reset': '1789000000000' } },
    );

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.resetAt?.toISOString(), new Date(1789000000000).toISOString());
        return true;
      },
    );
  });

  it('accepts Retry-After as an HTTP date', async () => {
    mock.pushRaw('', { status: 429, headers: { 'retry-after': 'Thu, 12 Nov 2026 09:01:00 GMT' } });

    await assert.rejects(
      () => client.teams(),
      (err: unknown) => {
        assert.ok(err instanceof LinearRateLimitError);
        assert.equal(err.resetAt?.toISOString(), '2026-11-12T09:01:00.000Z');
        return true;
      },
    );
  });

  it('leaves resetAt undefined when Linear names no time, or an unreadable one', async () => {
    mock.pushRaw('', { status: 429 });
    await assert.rejects(
      () => client.teams(),
      (err: unknown) => err instanceof LinearRateLimitError && err.resetAt === undefined,
    );

    mock.pushRaw('', { status: 429, headers: { 'retry-after': 'soon' } });
    await assert.rejects(
      () => client.teams(),
      (err: unknown) => err instanceof LinearRateLimitError && err.resetAt === undefined,
    );
  });

  it('still recognises the HTTP 400 + RATELIMITED shape Linear used before', async () => {
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

describe('connection observer', () => {
  const VIEWER = {
    data: { viewer: { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true } },
  };

  it('is told when a request succeeds', async () => {
    mock.push(VIEWER);
    await client.viewer();

    assert.deepEqual(observed, ['succeeded']);
  });

  it('is told the refusal when Linear rejects the key', async () => {
    mock.pushRaw('Unauthorized', { status: 401 });
    await assert.rejects(() => client.viewer());

    mock.push({ errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }] });
    await assert.rejects(() => client.viewer());

    assert.deepEqual(observed, ['rejected:http_401', 'rejected:protocol_auth_failure']);
  });

  it('is told nothing for a failure that says nothing about the key', async () => {
    mock.pushRaw('<html>502 Bad Gateway</html>', { status: 502 });
    await assert.rejects(() => client.teams());

    mock.pushRaw('', { status: 429 });
    await assert.rejects(() => client.teams());

    mock.push({ errors: [{ message: 'Field "nope" does not exist' }] });
    await assert.rejects(() => client.teams());

    mock.pushRaw('not json at all');
    await assert.rejects(() => client.teams());

    assert.deepEqual(observed, []);
  });

  it('counts a declined mutation as an accepted key', async () => {
    mock.push({ data: { commentCreate: { success: false, comment: null } } });
    await assert.rejects(() => client.addComment('i1', 'x'), LinearMutationError);

    assert.deepEqual(observed, ['succeeded']);
  });

  it('cannot change the outcome of a request by throwing', async () => {
    const throwing = createLinearClient({
      apiKey: API_KEY,
      fetch: (u, i) => mock.fetch(u, i),
      observer: {
        authRejected: () => {
          throw new Error('observer broke');
        },
        succeeded: () => {
          throw new Error('observer broke');
        },
      },
    });

    mock.push(VIEWER);
    assert.equal((await throwing.viewer()).id, 'u1');

    mock.pushRaw('Unauthorized', { status: 401 });
    await assert.rejects(() => throwing.viewer(), LinearAuthError);
  });

  it('is optional', async () => {
    const bare = createLinearClient({ apiKey: API_KEY, fetch: (u, i) => mock.fetch(u, i) });

    mock.push(VIEWER);
    assert.equal((await bare.viewer()).id, 'u1');
  });
});
