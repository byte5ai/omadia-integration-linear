import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PluginContext } from '@omadia/plugin-api';

import { LINEAR_API_SERVICE_NAME, activate } from '../src/plugin.js';
import { LINEAR_GRAPHQL_ENDPOINT, type LinearClient } from '../src/client.js';

/**
 * Activation is small but it is the only place the credential, the host's
 * allow-listed fetch and the capability registration meet — and each of those
 * three failing quietly looks the same from the outside (an agent plugin that
 * "can't reach Linear"). So: the key must come from the vault, the client must
 * go through `ctx.http.fetch` rather than global fetch, the service must be
 * registered under the name the manifest promises, and `close()` must give it
 * back.
 */

const VIEWER_RESPONSE = {
  data: { viewer: { id: 'u1', name: 'Ada', displayName: 'ada', email: null, active: true } },
};

interface Harness {
  ctx: PluginContext;
  fetches: { url: string; init: RequestInit | undefined }[];
  provided: Map<string, unknown>;
  disposed: string[];
  logs: string[];
}

function createHarness(
  overrides: { http?: boolean; secret?: string | Error; fetchBody?: unknown; fetchStatus?: number } = {},
): Harness {
  const fetches: { url: string; init: RequestInit | undefined }[] = [];
  const provided = new Map<string, unknown>();
  const disposed: string[] = [];
  const logs: string[] = [];

  const http = {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      fetches.push({ url, init });
      return new Response(JSON.stringify(overrides.fetchBody ?? VIEWER_RESPONSE), {
        status: overrides.fetchStatus ?? 200,
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
  } as unknown as PluginContext;

  return { ctx, fetches, provided, disposed, logs };
}

describe('activate', () => {
  it('publishes the Linear API capability under the manifest-declared name', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    await handle.connectionCheck;

    assert.equal(LINEAR_API_SERVICE_NAME, 'linear.api');
    assert.ok(h.provided.has(LINEAR_API_SERVICE_NAME));
    await handle.close();
  });

  it('builds the client on ctx.http.fetch, carrying the vault key', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    await handle.connectionCheck;

    const client = h.provided.get(LINEAR_API_SERVICE_NAME) as LinearClient;
    await client.viewer();

    // The probe fired once, the explicit call once — both through ctx.http.
    assert.ok(h.fetches.length >= 2, `expected 2 fetches, saw ${String(h.fetches.length)}`);
    const last = h.fetches[h.fetches.length - 1];
    assert.equal(last?.url, LINEAR_GRAPHQL_ENDPOINT);
    assert.equal(
      (last?.init?.headers as Record<string, string> | undefined)?.['Authorization'],
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

  it('logs the identity the key acts as, so the operator can spot a wrong key', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    await handle.connectionCheck;

    assert.ok(
      h.logs.some((l) => l.includes('connection ok') && l.includes('ada')),
      `no connection-ok log line in ${JSON.stringify(h.logs)}`,
    );
    await handle.close();
  });

  it('survives a failing connection check — Linear being down is not a boot failure', async () => {
    const h = createHarness({ fetchStatus: 401, fetchBody: { errors: [{ message: 'nope' }] } });
    const handle = await activate(h.ctx);
    await handle.connectionCheck;

    assert.ok(h.provided.has(LINEAR_API_SERVICE_NAME), 'capability must stay published');
    assert.ok(
      h.logs.some((l) => l.includes('connection check FAILED')),
      `no failure log line in ${JSON.stringify(h.logs)}`,
    );
    await handle.close();
  });
});

describe('close', () => {
  it('unregisters the capability', async () => {
    const h = createHarness();
    const handle = await activate(h.ctx);
    await handle.connectionCheck;
    await handle.close();

    assert.deepEqual(h.disposed, [LINEAR_API_SERVICE_NAME]);
    assert.equal(h.provided.size, 0);
  });
});
