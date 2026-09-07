import type { PluginContext } from '@omadia/plugin-api';

import { createLinearClient, type LinearClient } from './client.js';

/**
 * `@omadia/integration-linear` — the Linear connection.
 *
 * A `kind: integration` plugin, so it contributes no tools and no prompt. Its
 * whole job is to hold the credential for one Linear workspace and publish the
 * Linear API capability, which `@omadia/agent-linear` consumes:
 *
 *     provides: ["linear.api@1"]        →  ctx.services.provide('linear.api', client)
 *     requires: ["linear.api@^1"]       →  ctx.services.get<LinearClient>('linear.api')
 *
 * The credential never leaves this package: the agent plugin declares
 * `depends_on: ["@omadia/integration-linear"]` and reaches Linear only through
 * the published client. That is also why the agent must NOT redeclare
 * `linear_api_key` as a setup field of its own — a redeclared field silently
 * overrides the parent's value.
 *
 * Lifecycle budgets: `activate()` has 10 s, `close()` has 5 s. Both are met
 * with room to spare — activation builds one object and registers one service;
 * the connection check runs detached (see below).
 *
 * The client contract consumers read is INTEGRATION.md.
 */

/** Capability name. Must match `provides:` in manifest.yaml. */
export const LINEAR_API_SERVICE_NAME = 'linear.api';

export interface LinearIntegrationHandle {
  close(): Promise<void>;
  /**
   * Resolves when the connection check below has finished, whatever its
   * outcome — it never rejects. Exposed because the alternative is work that
   * activation starts and nothing can observe: the test for it would have to
   * guess at a number of event-loop ticks, which is a flake, not a test.
   */
  readonly connectionCheck: Promise<void>;
}

/**
 * One `viewer` query, logged, never thrown.
 *
 * Not awaited by `activate()`, because a blocking check would put a third
 * party's availability on the critical path of every core boot — a Linear
 * outage would then read as "the plugin is broken". What the operator needs is
 * the answer visible right after pasting a key, and a log line delivers that
 * without making activation depend on it. `setup.self_test` stays false in the
 * manifest: the `onConfigure` hook it obliges a plugin to ship is declared in
 * the schema but not yet invoked by core.
 */
async function checkConnection(ctx: PluginContext, client: LinearClient): Promise<void> {
  try {
    const viewer = await client.viewer();
    ctx.log(`connection ok — key acts as ${viewer.displayName} (${viewer.id})`);
  } catch (err: unknown) {
    ctx.log(
      `connection check FAILED — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function activate(ctx: PluginContext): Promise<LinearIntegrationHandle> {
  ctx.log('activating linear connection');

  // `ctx.http` exists only when `permissions.network.outbound` is non-empty.
  // An empty allow-list is a manifest bug, and the plugin would otherwise fail
  // later with an unrelated-looking undefined access.
  const http = ctx.http;
  if (!http) {
    throw new Error(
      'linear: ctx.http is unavailable — permissions.network.outbound must list api.linear.app',
    );
  }

  const apiKey = await ctx.secrets.require('linear_api_key');

  const client = createLinearClient({
    apiKey,
    // Wrapped rather than passed as `http.fetch`: handing a method around
    // detached from its object is a `this`-binding bug waiting for the host to
    // implement the accessor as a class instead of an object literal.
    fetch: (url, init) => http.fetch(url, init),
  });

  const disposeClient = ctx.services.provide<LinearClient>(LINEAR_API_SERVICE_NAME, client);
  ctx.log(`service '${LINEAR_API_SERVICE_NAME}' published`);

  const connectionCheck = checkConnection(ctx, client);

  return {
    connectionCheck,
    async close(): Promise<void> {
      ctx.log('deactivating linear connection');
      // Deliberately not awaiting `connectionCheck`: close() has a 5 s budget
      // and a request to an unreachable host can outlive it. The check cannot
      // reject and touches nothing after activation, so leaving it to settle
      // on its own is safe.
      disposeClient();
    },
  };
}

export default { activate };

// The capability's type surface, re-exported so a consumer can write
// `import type { LinearClient } from '@omadia/integration-linear'` — the path
// manifest.yaml's `service_types` entry names.
export {
  createLinearClient,
  DEFAULT_ISSUE_LIMIT,
  LINEAR_GRAPHQL_ENDPOINT,
  LinearApiError,
  LinearAuthError,
  LinearGraphQLError,
  LinearMutationError,
  LinearRateLimitError,
  MAX_COMMENTS,
  MAX_ISSUE_LIMIT,
  MAX_LOOKUP_NODES,
} from './client.js';
export type {
  CreateIssueInput,
  FetchLike,
  LinearClient,
  LinearClientOptions,
  LinearComment,
  LinearGraphQLErrorEntry,
  LinearIssue,
  LinearIssueDetail,
  LinearIssueRef,
  LinearLabel,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  LinearWorkflowStateType,
  SearchIssuesInput,
  UpdateIssueInput,
} from './client.js';
