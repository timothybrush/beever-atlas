import { describe, it } from "node:test";
import assert from "node:assert";
import { decideSubscribedAction } from "./trigger.js";

const T = 2; // quiet threshold used across cases

describe("decideSubscribedAction", () => {
  it("skips the bot's own messages", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMe: true, isMention: true, quietThreshold: T }),
      "skip",
    );
  });

  it("skips other bots", () => {
    assert.strictEqual(
      decideSubscribedAction({ isBot: true, quietThreshold: T }),
      "skip",
    );
  });

  it("treats isBot='unknown' as a human (does not skip)", () => {
    assert.strictEqual(
      decideSubscribedAction({ isBot: "unknown", humanCount: 1, quietThreshold: T }),
      "answer",
    );
  });

  it("always answers an explicit mention, even in a busy thread", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMention: true, humanCount: 9, quietThreshold: T }),
      "answer",
    );
  });

  it("answers non-mention follow-ups while effectively 1:1", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMention: false, humanCount: 1, quietThreshold: T }),
      "answer",
    );
  });

  it("withdraws (unsubscribe) from a multi-human, non-mention thread", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMention: false, humanCount: 2, quietThreshold: T }),
      "unsubscribe",
    );
    assert.strictEqual(
      decideSubscribedAction({ isMention: false, humanCount: 5, quietThreshold: T }),
      "unsubscribe",
    );
  });

  it("answers when participant count is unknown (never goes silent on uncertainty)", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMention: false, quietThreshold: T }),
      "answer",
    );
  });

  it("prioritizes self/bot skip over mention", () => {
    assert.strictEqual(
      decideSubscribedAction({ isMe: true, isBot: true, isMention: true, quietThreshold: T }),
      "skip",
    );
  });
});
