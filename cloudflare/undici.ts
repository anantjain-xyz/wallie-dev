/** Vercel Sandbox 1.x passes this pool as RequestInit.dispatcher. Cloudflare
 * owns connection pooling; its native fetch ignores Node's dispatcher option.
 * This build-only adapter prevents importing Undici's Node socket/mock stack.
 */
export class Agent {
  constructor(_options?: unknown) {
    void _options;
  }
  async close() {}
}
