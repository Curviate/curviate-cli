import { describe, expect, it } from "vitest";
import { slimInviteSentItem } from "../../src/lib/slim.js";

describe("connect sent: the slim item keeps the recipient's public_identifier", () => {
  it.each([
    [{ id: "ACoAA1", display_name: "A", public_identifier: "jane-doe" }, "jane-doe"],
    [{ id: "ACoAA2", display_name: "B" }, null],
  ])("user %o -> public_identifier %s", (user, want) => {
    expect((slimInviteSentItem({ object: "invitation_sent", id: "SENT_1", user }).user as Record<string, unknown>)["public_identifier"]).toBe(want);
  });
});
