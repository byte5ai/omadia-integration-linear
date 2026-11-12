import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import * as plugin from '../src/plugin.js';
import { LINEAR_API_SERVICE_NAME, activate } from '../src/plugin.js';
import { LINEAR_GRAPHQL_ENDPOINT, LinearAuthError, type LinearClient } from '../src/client.js';

/**
 * Activation is small but it is the only place the credential, the host's
 * allow-listed fetch and the capability registration meet — and each of those
 * three failing quietly looks the same from the outside (an agent plugin that
 * "can't reach Linear"). So: the key must come from the vault, the client must
 * go through `ctx.http.fetch` rather than global fetch, the service must be
 * registered under the name the manifest promises, and `close()` must give it
 * back.
 *
 * Activation itself says nothing about whether the key works. That is the
 * connection check's answer (tests/connectionStatus.test.ts); what belongs
 * here is that the published client keeps the status current in between.
 */

const VIEWER_RESPONSE = {
  data: { viewer: { id: 'u1', name: 'Ada Lovelace', displayName: 'ada', email: null, active: true } },
};

interface Reply {
  body: unknown;
  status?: number;
}

interface Harness {
  ctx: PluginContext;
  fetches: { url: string; init: RequestInit | undefined }[];
  provided: Map<string, unknown>;
  disposed: string[];
  logs: string[];
  /** Every status the plugin reported, in order. */
  statuses: { state: string; title?: string; detail?: string }[];
  /** Answer the next request with this instead of the viewer. */
  reply(next: Reply): void;
}

function createHarness(overrides: { http?: boolean; secret?: string | Error } = {}): Harness {
  const fetches: { url: string; init: RequestInit | undefined }[] = [];
  const provided = new Map<string, unknown>();
  const disposed: string[] = [];
  const logs: string[] = [];
  const statuses: { state: string; title?: string; detail?: string }[] = [];
  const queue: Reply[] = [];

  const http = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      fetches.push({ url, init });
      const next = queue.shift() ?? { body: VIEWER_RESPONSE };
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  };

  const ctx = {
    agentId: '@omadia/integration-linear',
    log: (...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    },
    http: overrides.http === false ? undefined : http,
    secrets: {
      require: async (key: string) => {
        const secret = overrides.secret ?? 'lin_api_TESTKEY';
        if (secret instanceof Error) throw secret;
        assert.equal(key, 'linear_api_key');
        return secret;
      },
    },
    config: { get: () => undefined },
    services: {
      provide: (name: string, impl: unknown) => {
        provided.set(name, impl);
        return () => {
          disposed.push(name);
          provided.delete(name);
        };
      },
    },
    status: {
      report: (status: { state: string; title?: string; detail?: string }) => {
        statuses.push(status);
      },
      clear: () => {
        statuses.push({ state: 'cleared' });
      },
    },
  } as unknown as PluginContext;

  return {
    ctx,
    fetches,
    provided,
    disposed,
    logs,
    statuses,
    reply: (next) => {
      queue.push(next);
    },
  };
}

const UNAUTHORIZED: Reply = {
  status: 401,
  body: { errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }] },
};

describe('activate', () => {
  it('publishes the Linear API capability under the manifest-declared name', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);

    assert.equal(LINEAR_API_SERVICE_NAME, 'linear.api');
    assert.ok(h.provided.has(LINEAR_API_SERVICE_NAME));
    await handle.close();
  });

  it('sends nothing to Linear — an outage there cannot fail or slow an activation', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);

    assert.equal(h.fetches.length, 0);
    assert.deepEqual(h.statuses, [], 'activation is not a verdict on the key');
    await handle.close();
  });

  it('builds the client on ctx.http.fetch, carrying the vault key', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);

    const client = h.provided.get(LINEAR_API_SERVICE_NAME) as LinearClient;
    await client.viewer();

    assert.equal(h.fetches.length, 1);
    const sent = h.fetches[0];
    assert.equal(sent?.url, LINEAR_GRAPHQL_ENDPOINT);
    assert.equal(
      (sent?.init?.headers as Record<string, string> | undefined)?.['Authorization'],
      'lin_api_TESTKEY',
    );
    await handle.close();
  });

  it('refuses to activate when the manifest granted no outbound host', async () => {
    const h = createHarness({ http: false });

    await assert.rejects(() => activate(h.ctx), /permissions\.network\.outbound/);
    assert.equal(h.provided.size, 0, 'must not publish a client it cannot use');
  });

  it('fails activation when the API key is not configured', async () => {
    const h = createHarness({ secret: new Error('MissingSecretError: linear_api_key') });

    await assert.rejects(() => activate(h.ctx), /linear_api_key/);
    assert.equal(h.provided.size, 0);
  });
});

describe('connection status between two checks', () => {
  it('reports error when Linear refuses the key during an ordinary request', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    const client = h.provided.get(LINEAR_API_SERVICE_NAME) as LinearClient;

    h.reply(UNAUTHORIZED);
    await assert.rejects(() => client.teams(), LinearAuthError);

    assert.deepEqual(h.statuses, [{ state: 'error' }]);
    await handle.close();
  });

  it('reports ok again once a request succeeds after such a refusal', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    const client = h.provided.get(LINEAR_API_SERVICE_NAME) as LinearClient;

    h.reply(UNAUTHORIZED);
    await assert.rejects(() => client.viewer(), LinearAuthError);
    await client.viewer();

    assert.deepEqual(h.statuses, [{ state: 'error' }, { state: 'ok' }]);
    await handle.close();
  });

  it('reports nothing while requests succeed, and nothing for an outage', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    const client = h.provided.get(LINEAR_API_SERVICE_NAME) as LinearClient;

    await client.viewer();
    h.reply({ status: 502, body: { message: 'bad gateway' } });
    await assert.rejects(() => client.viewer());
    h.reply({ status: 429, body: { errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] } });
    await assert.rejects(() => client.viewer());

    assert.deepEqual(h.statuses, []);
    await handle.close();
  });
});

describe('module exports', () => {
  it('offers the connection check where the host looks for it', () => {
    // The host reads `verifyConnection` off the module, and off the default
    // export as a fallback.
    assert.equal(typeof plugin.verifyConnection, 'function');
    assert.equal(plugin.default.verifyConnection, plugin.verifyConnection);
    assert.equal(plugin.default.activate, plugin.activate);
  });
});

describe('close', () => {
  it('unregisters the capability', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    await handle.close();

    assert.deepEqual(h.disposed, [LINEAR_API_SERVICE_NAME]);
    assert.equal(h.provided.size, 0);
  });
});
