import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { LINEAR_GRAPHQL_ENDPOINT } from '../src/client.js';
import {
  CallTimeStatusReporter,
  CONNECTION_CHECK_TIMEOUT_MS,
  checkLinearConnection,
  verifyConnection,
} from '../src/connectionStatus.js';

/**
 * The connection check is the one place this plugin tells an operator "your
 * key is wrong", and the host acts on that sentence: a rejected verdict turns
 * the plugin red and withholds its tools. So the cases below are split by the
 * only distinction that matters — did Linear refuse the key, or did the check
 * simply not get an answer — and every case of the second kind has to come
 * out inconclusive.
 *
 * `acceptedByHost` restates the host's rule for a verdict it takes on trust,
 * because this package cannot import the host: a rejection counts only with
 * one of the three causes the host recognises.
 */

const VIEWER = {
  data: { viewer: { id: 'u1', name: 'Ada Lovelace', displayName: 'ada', email: null, active: true } },
};

const HOST_REJECTION_CAUSES = ['http_401', 'http_403_auth', 'protocol_auth_failure'];

function acceptedByHost(verdict: { status: string; cause?: string }): boolean {
  if (verdict.status !== 'rejected') return true;
  return typeof verdict.cause === 'string' && HOST_REJECTION_CAUSES.includes(verdict.cause);
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

interface Harness {
  ctx: PluginContext;
  fetches: { url: string; init: RequestInit | undefined }[];
  logs: string[];
}

function json(body: unknown, status = 200): FetchImpl {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

function raw(body: string, status = 200, headers: Record<string, string> = {}): FetchImpl {
  return async () => new Response(body, { status, headers: { 'content-type': 'text/html', ...headers } });
}

function createHarness(
  fetchImpl: FetchImpl,
  overrides: { http?: boolean; secret?: string | Error; log?: () => void } = {},
): Harness {
  const fetches: { url: string; init: RequestInit | undefined }[] = [];
  const logs: string[] = [];

  const ctx = {
    agentId: '@omadia/integration-linear',
    log:
      overrides.log ??
      ((...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(' '));
      }),
    http:
      overrides.http === false
        ? undefined
        : {
            fetch: (url: string, init?: RequestInit) => {
              fetches.push({ url, init });
              return fetchImpl(url, init);
            },
          },
    secrets: {
      require: async (key: string) => {
        const secret = overrides.secret ?? 'lin_api_TESTKEY';
        if (secret instanceof Error) throw secret;
        assert.equal(key, 'linear_api_key');
        return secret;
      },
    },
  } as unknown as PluginContext;

  return { ctx, fetches, logs };
}

describe('connection check — the key works', () => {
  it('answers connected and names the key owner in the detail', async () => {
    const h = createHarness(json(VIEWER));

    const verdict = await verifyConnection(h.ctx);

    assert.deepEqual(verdict, { status: 'connected', detail: 'Ada Lovelace' });
  });

  it('sends one viewer query with the stored key through ctx.http', async () => {
    const h = createHarness(json(VIEWER));

    await verifyConnection(h.ctx);

    assert.equal(h.fetches.length, 1);
    const sent = h.fetches[0];
    assert.equal(sent?.url, LINEAR_GRAPHQL_ENDPOINT);
    assert.equal(
      (sent?.init?.headers as Record<string, string> | undefined)?.['Authorization'],
      'lin_api_TESTKEY',
    );
    assert.match(String(sent?.init?.body), /viewer/);
    assert.ok(sent?.init?.signal instanceof AbortSignal, 'the request carries its own time limit');
  });

  it('falls back to the display name when Linear sends no full name', async () => {
    const h = createHarness(
      json({ data: { viewer: { id: 'u1', name: '', displayName: 'ada', email: null, active: true } } }),
    );

    assert.deepEqual(await verifyConnection(h.ctx), { status: 'connected', detail: 'ada' });
  });

  it('sends no title — the admin UI words each state in the operator\'s language', async () => {
    const h = createHarness(json(VIEWER));

    assert.ok(!('title' in (await verifyConnection(h.ctx))));
  });
});

describe('connection check — Linear refused the key', () => {
  it('HTTP 401 → rejected, cause http_401', async () => {
    const h = createHarness(raw('Unauthorized', 401));

    const verdict = await verifyConnection(h.ctx);

    assert.deepEqual(verdict, { status: 'rejected', cause: 'http_401' });
    assert.ok(acceptedByHost(verdict));
  });

  it('HTTP 401 with a GraphQL body → rejected, cause http_401', async () => {
    const h = createHarness(
      json({ errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 401),
    );

    assert.deepEqual(await verifyConnection(h.ctx), { status: 'rejected', cause: 'http_401' });
  });

  it('HTTP 403 whose body names authentication → rejected, cause http_403_auth', async () => {
    const h = createHarness(raw('{"error":"authentication failed"}', 403));

    const verdict = await verifyConnection(h.ctx);

    assert.deepEqual(verdict, { status: 'rejected', cause: 'http_403_auth' });
    assert.ok(acceptedByHost(verdict));
  });

  it('authentication error inside errors[] under HTTP 200 → rejected, cause protocol_auth_failure', async () => {
    const h = createHarness(
      json({ errors: [{ message: 'Authentication required', extensions: { type: 'authentication error' } }] }),
    );

    const verdict = await verifyConnection(h.ctx);

    assert.deepEqual(verdict, { status: 'rejected', cause: 'protocol_auth_failure' });
    assert.ok(acceptedByHost(verdict));
  });

  it('the same error under HTTP 400 → rejected, cause protocol_auth_failure', async () => {
    const h = createHarness(
      json({ errors: [{ message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } }] }, 400),
    );

    assert.deepEqual(await verifyConnection(h.ctx), {
      status: 'rejected',
      cause: 'protocol_auth_failure',
    });
  });

  it('logs the cause and never the key', async () => {
    const h = createHarness(raw('Unauthorized', 401));

    await verifyConnection(h.ctx);

    assert.ok(h.logs.some((l) => l.includes('rejected the API key') && l.includes('http_401')));
    assert.ok(!h.logs.some((l) => l.includes('lin_api_TESTKEY')));
  });
});

describe('connection check — no answer about the key', () => {
  const INCONCLUSIVE = { status: 'inconclusive' };

  it('HTTP 5xx → inconclusive', async () => {
    const h = createHarness(raw('<html>502 Bad Gateway</html>', 502));

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('rate limit, HTTP 429 → inconclusive', async () => {
    const h = createHarness(
      json({ errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] }, 429),
    );

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('HTTP 403 that does not name authentication → inconclusive', async () => {
    const h = createHarness(raw('{"error":"not available in your region"}', 403));

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('any other GraphQL error → inconclusive', async () => {
    const h = createHarness(json({ errors: [{ message: 'Internal server error' }] }));

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('HTTP 200 that is not a GraphQL answer (proxy login page) → inconclusive', async () => {
    const h = createHarness(raw('<html>Please sign in</html>'));

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('an answer that names no key owner → inconclusive', async () => {
    const h = createHarness(json({ data: { viewer: null } }));

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('network failure → inconclusive', async () => {
    const h = createHarness(async () => {
      throw new TypeError('fetch failed');
    });

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
  });

  it('a request that outlasts the time limit → inconclusive', async () => {
    // The time limit's own timer does not keep a process alive. A server has
    // other reasons to stay up; this test needs one of its own, or the runner
    // would see an idle event loop and cancel it.
    const hanging: FetchImpl = (_url, init) =>
      new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => undefined, 5_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    const h = createHarness(hanging);

    assert.deepEqual(await checkLinearConnection(h.ctx, 20), INCONCLUSIVE);
  });

  it('gives up before the host stops waiting', () => {
    // The host allows a connection check five seconds.
    assert.ok(CONNECTION_CHECK_TIMEOUT_MS < 5_000);
  });

  it('no outbound grant → inconclusive, without a request', async () => {
    const h = createHarness(json(VIEWER), { http: false });

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
    assert.equal(h.fetches.length, 0);
  });

  it('no key stored → inconclusive, without a request', async () => {
    const h = createHarness(json(VIEWER), { secret: new Error('MissingSecretError: linear_api_key') });

    assert.deepEqual(await verifyConnection(h.ctx), INCONCLUSIVE);
    assert.equal(h.fetches.length, 0);
  });

  it('says in the log why, because nothing else records it', async () => {
    const h = createHarness(raw('<html>502 Bad Gateway</html>', 502));

    await verifyConnection(h.ctx);

    assert.ok(
      h.logs.some((l) => l.includes('inconclusive') && l.includes('HTTP 502')),
      `no reason in ${JSON.stringify(h.logs)}`,
    );
  });

  it('never throws, even when the log does', async () => {
    const failingLog = (): void => {
      throw new Error('log sink is gone');
    };

    const ok = createHarness(json(VIEWER), { log: failingLog });
    assert.equal((await verifyConnection(ok.ctx)).status, 'connected');

    const refused = createHarness(raw('Unauthorized', 401), { log: failingLog });
    assert.equal((await verifyConnection(refused.ctx)).status, 'rejected');

    const down = createHarness(raw('nope', 503), { log: failingLog });
    assert.equal((await verifyConnection(down.ctx)).status, 'inconclusive');
  });
});

describe('CallTimeStatusReporter', () => {
  function createSink(): { reports: { state: string }[]; report(status: { state: string }): void } {
    const reports: { state: string }[] = [];
    return {
      reports,
      report(status) {
        reports.push(status);
      },
    };
  }

  it('reports error for a refused key, without wording of its own', () => {
    const sink = createSink();
    const reporter = new CallTimeStatusReporter(sink);

    reporter.authRejected('http_401');

    assert.deepEqual(sink.reports, [{ state: 'error' }]);
  });

  it('reports every refusal, not only the first', () => {
    // The host's own check writes to the same status and may have cleared it
    // in between.
    const sink = createSink();
    const reporter = new CallTimeStatusReporter(sink);

    reporter.authRejected('http_401');
    reporter.authRejected('protocol_auth_failure');

    assert.deepEqual(sink.reports, [{ state: 'error' }, { state: 'error' }]);
  });

  it('reports ok once after an error it raised itself', () => {
    const sink = createSink();
    const reporter = new CallTimeStatusReporter(sink);

    reporter.authRejected('http_401');
    reporter.succeeded();
    reporter.succeeded();

    assert.deepEqual(sink.reports, [{ state: 'error' }, { state: 'ok' }]);
  });

  it('leaves a status alone that it did not raise', () => {
    // A rejected verdict written by the host must not be cleared by a request
    // that happened to work.
    const sink = createSink();
    const reporter = new CallTimeStatusReporter(sink);

    reporter.succeeded();

    assert.deepEqual(sink.reports, []);
  });

  it('does not throw when the host refuses the report, and tries again next time', () => {
    const logs: string[] = [];
    let refuse = true;
    const reports: { state: string }[] = [];
    const reporter = new CallTimeStatusReporter(
      {
        report(status) {
          if (refuse) throw new Error('registry is gone');
          reports.push(status);
        },
      },
      (message) => {
        logs.push(message);
      },
    );

    reporter.authRejected('http_401');
    assert.ok(logs.some((l) => l.includes("could not report status 'error'")));

    // The failed report raised nothing, so a success has nothing to clear.
    refuse = false;
    reporter.succeeded();
    assert.deepEqual(reports, []);

    reporter.authRejected('http_401');
    assert.deepEqual(reports, [{ state: 'error' }]);
  });

  it('does nothing on a host that has no status', () => {
    const reporter = new CallTimeStatusReporter(undefined);

    reporter.authRejected('http_401');
    reporter.succeeded();
  });

  it('does not throw when its log does', () => {
    const sink = createSink();
    const reporter = new CallTimeStatusReporter(sink, () => {
      throw new Error('log sink is gone');
    });

    reporter.authRejected('http_401');
    reporter.succeeded();

    assert.deepEqual(sink.reports, [{ state: 'error' }, { state: 'ok' }]);
  });
});
