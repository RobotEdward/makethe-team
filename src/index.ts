import { createApp } from "./app.js";
import type { Bindings } from "./env.js";

const app = createApp();

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Bindings>;
