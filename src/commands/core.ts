/**
 * `curviate core`: the LinkedIn building blocks. A pure group
 * of lazy loaders, so `curviate core --help` imports no command module
 *; each entry loads only when its group is invoked.
 */
import { defineCommand } from "citty";
import { DESCRIPTIONS, lazy } from "./descriptions.js";

export const coreCommand = defineCommand({
  meta: {
    name: "core",
    description: DESCRIPTIONS.core,
    rules: {
      notes: [
        "Writes reach LinkedIn immediately and are seen by the people they touch.",
        "A retry after a timeout can repeat a write: requests carry no idempotency key. Read the current state before retrying.",
        "Budget rows, ceilings and what is left: `curviate account get <account_id>`.",
      ],
    },
  },
  subCommands: {
    profile: lazy("profile", () => import("./profile.js").then((m) => m.profileCommand)),
    company: lazy("company", () => import("./company.js").then((m) => m.companyCommand)),
    job: lazy("job", () => import("./job.js").then((m) => m.jobCommand)),
    connect: lazy("connect", () => import("./connect.js").then((m) => m.connectCommand)),
    search: lazy("search", () => import("./search.js").then((m) => m.searchCommand)),
    inbox: lazy("inbox", () => import("./inbox.js").then((m) => m.inboxCommand)),
    inboxes: lazy("inboxes", () => import("./inboxes.js").then((m) => m.inboxesCommand)),
    message: lazy("message", () => import("./message.js").then((m) => m.messageCommand)),
    post: lazy("post", () => import("./post.js").then((m) => m.postCommand)),
    comment: lazy("comment", () => import("./comment.js").then((m) => m.commentCommand)),
    "sales-nav": lazy("sales-nav", () => import("./sales-nav.js").then((m) => m.salesNavCommand)),
    recruiter: lazy("recruiter", () => import("./recruiter.js").then((m) => m.recruiterCommand)),
    group: lazy("group", () => import("./group.js").then((m) => m.groupCommand)),
    feed: lazy("feed", () => import("./feed.js").then((m) => m.feedCommand)),
    notification: lazy("notification", () => import("./notification.js").then((m) => m.notificationCommand)),
    draft: lazy("draft", () => import("./draft.js").then((m) => m.draftCommand)),
  },
  async run() {
    const { showHelp } = await import("../lib/examples.js");
    await showHelp(coreCommand, ["curviate", "core"]);
  },
});
