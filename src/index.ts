import { createApp } from "./app.js";
import { handleScheduled } from "./cron/handler.js";
import type { Bindings } from "./env.js";

// Cloudflare resolves a Durable Object's `class_name` against the Worker's
// entry module, so the class must be re-exported here even though nothing
// in this file uses it directly.
export { FixtureCapacity } from "./capacity/fixture-capacity.js";

const app = createApp();

export default {
  fetch: app.fetch,

  // Awaited, not handed to ctx.waitUntil: awaiting is what lets the runtime see
  // the rejection and mark the invocation failed. A waitUntil'd cron resolves
  // immediately whatever happens, so a total materialisation outage would look
  // exactly like a healthy run.
  async scheduled(event, env, _ctx): Promise<void> {
    await handleScheduled(event.cron, env, new Date(event.scheduledTime));
  },
} satisfies ExportedHandler<Bindings>;
