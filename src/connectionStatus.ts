import type {
  ConnectionRejectionCause,
  PluginConnectionVerdict,
  PluginContext,
  StatusAccessor,
} from '@omadia/plugin-api';

import {
  createLinearClient,
  LinearAuthError,
  type LinearAuthRejection,
  type LinearConnectionObserver,
} from './client.js';

/**
 * Whether the stored API key works, where the operator can see it.
 *
 * Two writers feed the plugin's status, which the host shows as a badge in the
 * Store and as a banner on the plugin's page:
 *
 * - the host, which runs {@link verifyConnection} after every activation and
 *   when the operator presses "check connection";
 * - {@link CallTimeStatusReporter}, because that check runs at those two
 *   moments only: a key revoked in Linear while the plugin is up is first
 *   seen by an ordinary request.
 *
 * Both follow one rule. Only an explicit refusal of the key is a verdict on
 * the key. A timeout, a 5xx, a rate limit or an unreachable network says
 * nothing about it and leaves the status as it was — a red status also
 * withholds a plugin's tools from the orchestrator, so an outage read as a
 * dead key would take Linear away from every conversation.
 *
 * No `title` is sent. The plugin cannot see the operator's language, and the
 * admin UI has its own wording for each state.
 *
 * `@omadia/plugin-api` is imported for its types only. A named import of a
 * runtime export the host does not have fails the whole module at link time,
 * so the classification is written out here and the plugin loads on every
 * host in its `compat.core` range; a host without the connection check
 * ignores the export.
 */

/** The secret the connection is configured with. */
export const LINEAR_API_KEY_SECRET = 'linear_api_key';

/**
 * Budget of the one request the check makes. The host waits five seconds for
 * a verdict; the request gives up first, so it never outlives that wait.
 */
export const CONNECTION_CHECK_TIMEOUT_MS = 4_000;

const INCONCLUSIVE: PluginConnectionVerdict = Object.freeze({ status: 'inconclusive' });

/** Log without letting a failing logger turn into a verdict. */
function note(ctx: PluginContext, message: string): void {
  try {
    ctx.log(message);
  } catch {
    // A verdict is worth more than its log line.
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The check itself: one `viewer` query with the stored key, through the
 * plugin's own allow-listed fetch.
 *
 * - `connected` — Linear answered with the key's owner, who goes into
 *   `detail` so the operator sees whose key this is.
 * - `rejected` — Linear refused the key; `cause` names the refusal.
 * - `inconclusive` — everything else, a missing key or a missing outbound
 *   grant included. The reason goes to the log, because an inconclusive
 *   verdict returned by a plugin is logged nowhere else.
 *
 * Never throws. Uses a client of its own, without the call-time reporter: the
 * host writes this verdict into the status itself.
 */
export async function checkLinearConnection(
  ctx: PluginContext,
  timeoutMs: number = CONNECTION_CHECK_TIMEOUT_MS,
): Promise<PluginConnectionVerdict> {
  try {
    const http = ctx.http;
    if (!http) {
      note(ctx, 'connection check inconclusive — ctx.http is unavailable');
      return INCONCLUSIVE;
    }

    const client = createLinearClient({
      apiKey: await ctx.secrets.require(LINEAR_API_KEY_SECRET),
      fetch: (url, init) => http.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
    });
    const viewer = await client.viewer();

    // An answer that names nobody is not an accepted key.
    if (typeof viewer.id !== 'string' || viewer.id === '') {
      note(ctx, 'connection check inconclusive — Linear named no owner for the key');
      return INCONCLUSIVE;
    }

    const owner = viewer.name || viewer.displayName;
    note(ctx, `connection ok — key acts as ${owner} (${viewer.id})`);
    return owner ? { status: 'connected', detail: owner } : { status: 'connected' };
  } catch (err: unknown) {
    if (err instanceof LinearAuthError) {
      // Assignable without a cast only while this plugin's rejections remain
      // a subset of the causes the host recognises.
      const cause: ConnectionRejectionCause = err.rejection;
      note(ctx, `connection check: Linear rejected the API key (${cause})`);
      return { status: 'rejected', cause };
    }
    note(ctx, `connection check inconclusive — ${describe(err)}`);
    return INCONCLUSIVE;
  }
}

/** The module export the host looks for next to `activate`. */
export function verifyConnection(ctx: PluginContext): Promise<PluginConnectionVerdict> {
  return checkLinearConnection(ctx);
}

/**
 * Keeps the status current between two connection checks.
 *
 * A request Linear refuses for the key puts the plugin into `error` at once.
 * Every refusal is reported, not only the first: the host's check writes to
 * the same status and may have cleared it in between, and each report carries
 * a fresh timestamp.
 *
 * A request that succeeds afterwards reports `ok` — but only when the error
 * was raised here, so a status some other writer set is never cleared by a
 * request that happened to work.
 */
export class CallTimeStatusReporter implements LinearConnectionObserver {
  private raisedError = false;

  constructor(
    private readonly status: Pick<StatusAccessor, 'report'> | undefined,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  authRejected(rejection: LinearAuthRejection): void {
    if (this.write('error')) {
      this.raisedError = true;
      this.say(`Linear rejected the API key during a request (${rejection}) — status set to error`);
    }
  }

  succeeded(): void {
    if (!this.raisedError) return;
    if (this.write('ok')) {
      this.raisedError = false;
      this.say('Linear accepted the API key again — status cleared');
    }
  }

  /** `false` when the host took no report, a host without a status included. */
  private write(state: 'ok' | 'error'): boolean {
    try {
      if (this.status === undefined) return false;
      this.status.report({ state });
      return true;
    } catch (err: unknown) {
      this.say(`could not report status '${state}': ${describe(err)}`);
      return false;
    }
  }

  private say(message: string): void {
    try {
      this.log(message);
    } catch {
      // Nothing left to tell it to.
    }
  }
}
