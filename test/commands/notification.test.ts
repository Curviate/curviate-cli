/** `notification list|delete|show-less`: flag -> SDK call, output, --preview, refusals. */
import { describe, expect } from "vitest";
import { runNotificationDelete, runNotificationList, runNotificationShowLess } from "../../src/commands/notification.js";
import { calls, previews, prints, refuses, streams } from "../helpers/f3-unit.js";

const URN = "urn:li:fsd_notificationCard:(1)";
const SHAPE = {
  notifications: {
    list: { items: [{ card_urn: URN, text: "New comment" }], cursor: null, unread_count: 3 },
    delete: { object: "notification_card_deleted", deleted: true },
    showLess: { object: "notification_card_deleted", deleted: true },
  },
};

describe("notification", () => {
  calls(SHAPE, [
    ["list: no params by default", runNotificationList, {}, "notifications.list", [{}]],
    ["list --filter maps to filter", runNotificationList, { filter: "mentions" }, "notifications.list", [expect.objectContaining({ filter: "mentions" })]],
    ["list --limit/--cursor pass through", runNotificationList, { limit: "10", cursor: "cur_1" }, "notifications.list", [expect.objectContaining({ limit: 10, cursor: "cur_1" })]],
    ["delete passes the card urn verbatim, one argument", runNotificationDelete, { cardUrn: URN }, "notifications.delete", [URN]],
    ["show-less passes the card urn verbatim, one argument", runNotificationShowLess, { cardUrn: URN }, "notifications.showLess", [URN]],
  ]);
  prints(SHAPE, [
    ["list --json keeps unread_count", runNotificationList, {}, "notifications.list"],
    ["delete --json prints the confirmation", runNotificationDelete, { cardUrn: URN }, "notifications.delete"],
    ["show-less --json prints the confirmation", runNotificationShowLess, { cardUrn: URN }, "notifications.showLess"],
  ]);
  streams(SHAPE, [["list", runNotificationList, {}, "notifications.list"]]);
  previews(SHAPE, [
    ["delete", runNotificationDelete, { cardUrn: URN }, "notifications.delete", { args: { card_urn: URN }, body: {} }],
    ["show-less", runNotificationShowLess, { cardUrn: URN }, "notifications.showLess", { args: { card_urn: URN }, body: {} }],
  ]);
  refuses(SHAPE, [
    ["list with no connected account", runNotificationList, { account: null }, 2],
    ["delete with no connected account", runNotificationDelete, { cardUrn: URN, account: null }, 2],
  ]);
});
