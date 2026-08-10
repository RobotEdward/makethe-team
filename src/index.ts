import { createApp } from "./app.js";
import { handleScheduled } from "./cron/handler.js";
import type { Bindings } from "./env.js";

const app = createApp();

export default {
  fetch: app.fetch,

  async scheduled(event, env, ctx): Promise<void> {
    ctx.waitUntil(handleScheduled(event.cron, env, new Date(event.scheduledTime)));
  },
} satisfies ExportedHandler<Bindings>;
