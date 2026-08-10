import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("responds to a request", async () => {
    const response = await SELF.fetch("https://makethe.team/");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Break The Team");
  });
});
