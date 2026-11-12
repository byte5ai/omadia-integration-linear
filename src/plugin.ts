import type { PluginContext } from '@omadia/plugin-api';

import { createLinearClient, type LinearClient } from './client.js';
import {
  CallTimeStatusReporter,
  LINEAR_API_KEY_SECRET,
  verifyConnection,
} from './connectionStatus.js';

/**
 * `@omadia/integration-linear` — the Linear connection.
 *
 * A `kind: integration` plugin, so it contributes no tools and no prompt. Its
 * whole job is to hold the credential for one Linear workspace and publish the
 * Linear API capability, which `@omadia/agent-linear` consumes:
 *
 *     provides: ["linear.api@2"]        →  ctx.services.provide('linear.api', client)
 *     requires: ["linear.api@^2"]       →  ctx.services.get<LinearClient>('linear.api')
 *
 * The credential never leaves this package: the agent plugin declares
 * `depends_on: ["@omadia/integration-linear"]` and reaches Linear only through
 * the published client. That is also why the agent must NOT redeclare
 * `linear_api_key` as a setup field of its own — a redeclared field silently
 * overrides the parent's value.
 *
 * The module has two exports the host calls:
 *
 * - `activate(ctx)` builds the client and publishes it. It sends nothing to
 *   Linear, so a Linear outage cannot fail an activation or slow a boot.
 * - `verifyConnection(ctx)` answers whether the stored key works. The host
 *   runs it after every activation and on the operator's request, and shows
 *   the verdict in the Store. See src/connectionStatus.ts.
 *
 * Lifecycle budgets: `activate()` has 10 s, `close()` has 5 s, the connection
 * check 5 s.
 *
 * The client contract consumers read is INTEGRATION.md.
 */

/** Capability name. Must match `provides:` in manifest.yaml. */
export const LINEAR_API_SERVICE_NAME = 'linear.api';

export interface LinearIntegrationHandle {
  close(): Promise<void>;
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

  const apiKey = await ctx.secrets.require(LINEAR_API_KEY_SECRET);

  const client = createLinearClient({
    apiKey,
    // Wrapped rather than passed as `http.fetch`: handing a method around
    // detached from its object is a `this`-binding bug waiting for the host to
    // implement the accessor as a class instead of an object literal.
    fetch: (url, init) => http.fetch(url, init),
    // The connection check runs on activation and on request only. Between
    // the two, the requests themselves say whether Linear still takes the key.
    observer: new CallTimeStatusReporter(ctx.status, (message) => {
      ctx.log(message);
    }),
  });

  const disposeClient = ctx.services.provide<LinearClient>(LINEAR_API_SERVICE_NAME, client);
  ctx.log(`service '${LINEAR_API_SERVICE_NAME}' published`);

  return {
    async close(): Promise<void> {
      ctx.log('deactivating linear connection');
      disposeClient();
    },
  };
}

export { verifyConnection };

export default { activate, verifyConnection };

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
  LOOKUP_PAGE_SIZE,
  MAX_COMMENTS,
  MAX_ISSUE_LIMIT,
  MAX_LOOKUP_NODES,
} from './client.js';
export type {
  CreateIssueInput,
  FetchLike,
  LinearAuthRejection,
  LinearClient,
  LinearClientOptions,
  LinearComment,
  LinearConnectionObserver,
  LinearCycle,
  LinearCyclePhase,
  LinearCycleRef,
  LinearDateRange,
  LinearGraphQLErrorEntry,
  LinearIssue,
  LinearIssueDetail,
  LinearIssuePage,
  LinearIssueRef,
  LinearLabel,
  LinearProject,
  LinearProjectRef,
  LinearProjectStatusType,
  LinearTeam,
  LinearUser,
  LinearWorkflowState,
  LinearWorkflowStateType,
  SearchIssuesInput,
  UpdateIssueInput,
} from './client.js';
