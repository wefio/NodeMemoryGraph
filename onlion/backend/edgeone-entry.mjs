/**
 * EdgeOne Makers Cloud Function entry (Handler mode).
 *
 * Makers hands us a standard Request and returns whatever Response we produce,
 * so this is only an environment shim: R2's `MEMORY` binding becomes a COS
 * bucket and everything else is passed straight through to worker.mjs.
 * The EventContext's waitUntil is adapted into the execution slot, so
 * monitoring.mjs persists failures and the accept's fold runs after the
 * response instead of inside it.
 */
import worker from "./worker.mjs";
import { createCosBucketFromEnv } from "./cos-bucket.mjs";
import { recentFailures } from "./monitoring.mjs";
import { normalizeRequest } from "./edgeone-request.mjs";

export { worker };

let bucket;

/** Cold start builds the COS client once; every request reuses it. */
export function memoryBucket(env) {
  if (!bucket) bucket = createCosBucketFromEnv(env);
  return bucket;
}

/**
 * The platform turns handler exceptions into a generic 503 and hides the cause,
 * which makes a storage fault indistinguishable from a code fault. NMG_DEBUG_ERRORS=1
 * records the last storage failure so it can be returned instead. Off by default.
 */
let lastStorageError = null;

function recording(target) {
  const wrapped = {};
  for (const [name, operation] of Object.entries(target)) {
    wrapped[name] = async (...args) => {
      try {
        return await operation(...args);
      } catch (error) {
        lastStorageError = {
          operation: name,
          key: args[0],
          name: error?.name,
          code: error?.code,
          status: error?.status,
          message: error?.message,
        };
        throw error;
      }
    };
  }
  return wrapped;
}

// Exported by name on purpose. The platform discovers functions by statically
// reading export names, and `export default function onRequest` is rewritten by
// the bundler into `export { onRequest as default }` - whose exported name is
// `default`, which is not a handler name, so the function would silently not be
// registered (route 404s, "No node functions found" in dev). Keeping a named
// `onRequest` export, plus a default alias for convenience, satisfies both the
// scanner and the runtime.
export function onRequest(context) {
  // Platform docs read configuration from context.env. process.env stays as a
  // fallback because `edgeone makers dev` injects the project .env there.
  const env = { ...process.env, ...(context.env ?? {}) };
  // EventContext supplies waitUntil (request / params / env / waitUntil - Makers Functions
  // handbook): it extends this invocation's life past the response, which is what lets the
  // accept return first and fold afterwards. A no-op stands in where the context does not
  // carry it, so the call sites never branch on the platform's mood.
  const execution =
    typeof context?.waitUntil === "function"
      ? { waitUntil: (task) => context.waitUntil(task) }
      : undefined;
  return dispatch(normalizeRequest(context.request), env, context.server?.region, execution);
}

/**
 * `x-nmg-region` reports the region the function actually runs in. EdgeOne's
 * edgeone.json `cloudFunctions.regions` is advisory for an existing project, so
 * the deployed placement has to be observable rather than assumed.
 */
function withDiagnostics(response, region) {
  if (!region) return response;
  const headers = new Headers(response.headers);
  headers.set("x-nmg-region", String(region));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function dispatch(request, env, region, execution) {
  const debug = env.NMG_DEBUG_ERRORS === "1";
  const storage = memoryBucket(env);
  try {
    const response = await worker.fetch(
      request,
      {
        ...env,
        MEMORY: debug ? recording(storage) : storage,
        NMG_SERVER_REGION: region,
      },
      execution,
    );
    if (debug && response.status === 503) {
      const body = await response.clone().json().catch(() => null);
      return new Response(
        JSON.stringify({
          debug: true,
          trace_id: body?.trace_id,
          error: body?.error,
          storage_error: lastStorageError,
          failure: await recentFailures(storage)
            .then((list) => list.find((item) => item.trace_id === body?.trace_id) ?? null)
            .catch(() => null),
          has_cos_env: !!(env.NMG_COS_BUCKET && env.NMG_COS_SECRET_ID && env.NMG_COS_SECRET_KEY),
        }),
        { status: 599, headers: { "content-type": "application/json" } },
      );
    }
    return withDiagnostics(response, region);
  } catch (error) {
    if (!debug) throw error;
    return new Response(
      JSON.stringify({
        debug: true,
        name: error?.name,
        code: error?.code,
        message: error?.message,
        stack: String(error?.stack ?? "").split("\n").slice(0, 8),
        storage_error: lastStorageError,
      }),
      { status: 599, headers: { "content-type": "application/json" } },
    );
  }
}

export default onRequest;
