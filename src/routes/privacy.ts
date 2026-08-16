import { Hono } from "hono";
import { PRIVACY_PATH } from "../auth/paths.js";
import type { AppEnv } from "../env.js";
import { renderPrivacyPage } from "../views/privacy.js";

/**
 * `/privacy` (M7c).
 *
 * Mounted outside every session prefix and every token gate in `src/app.ts`,
 * which is the whole point: a person deciding whether to give this product
 * their email address must be able to read what happens to it *before* they
 * do, and somebody who never signs up at all still has the right to read it.
 *
 * Nothing here reads the request. The page is identical for everybody, so it
 * takes no session, no token, and no parameters — and it deliberately does not
 * get the `private, no-store` cache treatment the signed-in and token-scoped
 * mounts carry, because there is nothing here that is anybody's own data.
 */
export const privacy = new Hono<AppEnv>();

privacy.get(PRIVACY_PATH, (c) => c.html(renderPrivacyPage()));
