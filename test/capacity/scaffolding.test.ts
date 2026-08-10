import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("FixtureCapacity plumbing", () => {
  it("is reachable by fixture id over RPC", async () => {
    const stub = env.FIXTURE_CAPACITY.getByName("fixture-thursday");
    expect(await stub.ping()).toBe("fixture-capacity");
  });

  it("gives the same instance for the same fixture id", async () => {
    const a = env.FIXTURE_CAPACITY.getByName("fixture-a");
    const b = env.FIXTURE_CAPACITY.getByName("fixture-a");
    expect(a.id.toString()).toBe(b.id.toString());
  });

  it("gives different instances for different fixtures", async () => {
    const a = env.FIXTURE_CAPACITY.getByName("fixture-a");
    const b = env.FIXTURE_CAPACITY.getByName("fixture-b");
    expect(a.id.toString()).not.toBe(b.id.toString());
  });

  it("exposes its state for direct inspection in tests", async () => {
    const stub = env.FIXTURE_CAPACITY.getByName("fixture-inspect");
    const idInside = await runInDurableObject(stub, (_instance, state) => state.id.toString());
    expect(idInside).toBe(stub.id.toString());
  });

  it("registers instances that were addressed", async () => {
    env.FIXTURE_CAPACITY.getByName("fixture-listed");
    await env.FIXTURE_CAPACITY.getByName("fixture-listed").ping();
    const ids = await listDurableObjectIds(env.FIXTURE_CAPACITY);
    expect(ids.length).toBeGreaterThan(0);
  });
});
