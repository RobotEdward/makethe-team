import { describe, expect, it } from "vitest";
import type { EmailMessage, Message, Notifier, PushMessage, SendResult } from "../../src/notify/notifier.js";
import { NOTIFIER_CONTRACT_VIOLATION_REASON } from "../../src/notify/quota.js";
import { RouterNotifier } from "../../src/notify/router-notifier.js";

function emailMessage(to: string): EmailMessage {
  return {
    channel: "email",
    to,
    subject: "You're in",
    html: "<p>You're in</p>",
    text: "You're in",
    dedupeKey: `n1:fix-1:${crypto.randomUUID()}`,
  };
}

function pushMessage(to: string): PushMessage {
  return {
    channel: "push",
    to,
    title: "You're in",
    body: "You're in",
    url: "https://makethe.team/",
    tag: "fix-1",
    dedupeKey: `n1:fix-1:${crypto.randomUUID()}`,
  };
}

/** Records every message it was asked to send, in order, and answers with a
 * fixed `SendResult` (or a default success) for each — a spy standing in for
 * whichever real per-channel Notifier `RouterNotifier` would otherwise route
 * to. */
class RecordingNotifier implements Notifier {
  readonly received: Message[] = [];

  constructor(private readonly result: SendResult = { ok: true, providerMessageId: null }) {}

  send(messages: readonly Message[]): Promise<SendResult[]> {
    this.received.push(...messages);
    return Promise.resolve(messages.map(() => this.result));
  }
}

/** A Notifier that violates its own contract (notifier.ts) by returning
 * fewer results than it was given messages. */
class ShortNotifier implements Notifier {
  send(messages: readonly Message[]): Promise<SendResult[]> {
    return Promise.resolve(
      messages.slice(0, -1).map((): SendResult => ({ ok: true, providerMessageId: null })),
    );
  }
}

describe("RouterNotifier", () => {
  it("sends each message to the notifier for its channel", async () => {
    const email = new RecordingNotifier();
    const push = new RecordingNotifier();
    const router = new RouterNotifier(email, push);

    await router.send([emailMessage("a@x.com"), pushMessage("player-1")]);

    expect(email.received.map((m) => m.to)).toEqual(["a@x.com"]);
    expect(push.received.map((m) => m.to)).toEqual(["player-1"]);
  });

  it("returns results in the caller's order, whatever the mix", async () => {
    // The property that matters. Both legs see a dense array of their own
    // messages and answer in their own order; putting those two answers back
    // on the original indices is the whole job, and getting it wrong
    // attributes one player's failure to another.
    const email = new RecordingNotifier({ ok: true, providerMessageId: "e" });
    const push = new RecordingNotifier({ ok: false, error: "push-410" });
    const router = new RouterNotifier(email, push);

    const messages = [
      pushMessage("p1"), emailMessage("a@x.com"), pushMessage("p2"),
      pushMessage("p3"), emailMessage("b@x.com"),
    ];
    const results = await router.send(messages);

    expect(results).toHaveLength(messages.length);
    for (const [index, message] of messages.entries()) {
      const expected = message.channel === "email" ? "e" : "push-410";
      expect(JSON.stringify(results[index]), `index ${index}`).toContain(expected);
    }
  });

  it("answers an empty array with an empty array", async () => {
    // Named in the Notifier contract explicitly, and the case a split/merge
    // implementation is most likely to get wrong.
    const router = new RouterNotifier(new RecordingNotifier(), new RecordingNotifier());

    expect(await router.send([])).toEqual([]);
  });

  it("fills in a result for a leg that broke its own contract", async () => {
    // If a leg returns a short array, the messages beyond it have no result
    // of their own. Reusing the existing reason keeps this indistinguishable
    // from the same bug anywhere else in the chain.
    const router = new RouterNotifier(new ShortNotifier(), new RecordingNotifier());

    const results = await router.send([emailMessage("a@x.com"), emailMessage("b@x.com")]);

    expect(results[1]).toEqual({ ok: false, error: NOTIFIER_CONTRACT_VIOLATION_REASON });
  });
});
