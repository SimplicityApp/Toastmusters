/**
 * Test-only stand-in for the runtime's `cloudflare:workers` module, which only
 * exists inside workerd. vitest aliases the import here (worker/vitest.config.js);
 * wrangler bundles the real one.
 */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
