import { applyWorkerBindings } from "../../src/lib/cloudflare-env.ts";

/**
 * Copy Cloudflare bindings onto process.env for server functions.
 * The module handler also sets globalThis.__env__ before fetch. This
 * middleware covers a request whose context carries the same env object.
 * It does not read or write mail, and it does not attach a custom domain.
 */
type BindingEvent = {
  context?: {
    cloudflare?: {
      env?: Record<string, unknown>;
    };
  };
};

export default function cloudflareBindings(event: BindingEvent): void {
  const env = event.context?.cloudflare?.env;
  if (env) (globalThis as { __env__?: Record<string, unknown> }).__env__ = env;
  applyWorkerBindings();
}
