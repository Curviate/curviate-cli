/** `do-not-contact` over the wire: add then list, and what each verb sends. */
import { describe, it, expect } from "vitest";
import { useSink, line, type Hit } from "../helpers/sink.js";

const ENTRY = { object: "do_not_contact_entry", id: "dnc_1", contact: { id: "con_1", name: "Jane" }, reason: "asked_to_stop" };
const entries: unknown[] = [];
const sink = useSink((h: Hit) => {
  if (h.method === "POST") {
    entries.push(ENTRY);
    return { status: 201, body: ENTRY };
  }
  if (h.method === "DELETE") return { status: 204, body: "" };
  if (h.url.startsWith("/v1/do-not-contact/dnc_1")) return { body: ENTRY };
  return { body: { object: "do_not_contact_page", items: entries, cursor: null } };
});

describe("do-not-contact", () => {
  it("one add and one list: the entry added is the entry listed", async () => {
    entries.length = 0;
    const add = await sink.run(["do-not-contact", "add", "--contact", "con_1", "--reason", "asked_to_stop", "--json"]);
    expect([add.status, line(add.requests[0]!), JSON.parse(add.requests[0]!.body)]).toEqual([0, "POST /v1/do-not-contact", { contact_id: "con_1", reason: "asked_to_stop" }]);
    const list = await sink.run(["do-not-contact", "list", "--query", "jane", "--json"]);
    expect(list.requests[0]!.url).toBe("/v1/do-not-contact?q=jane");
    expect(JSON.parse(list.stdout).items).toEqual([ENTRY]);
  });

  it("add by URL, update, get, remove send their requests", async () => {
    const url = await sink.run(["do-not-contact", "add", "--linkedin-url", "https://www.linkedin.com/in/jane", "--json"]);
    expect(JSON.parse(url.requests[0]!.body)).toEqual({ linkedin_url: "https://www.linkedin.com/in/jane" });
    const upd = await sink.run(["do-not-contact", "update", "dnc_1", "--reason", "partner", "--json"]);
    expect([line(upd.requests[0]!), JSON.parse(upd.requests[0]!.body)]).toEqual(["PATCH /v1/do-not-contact/dnc_1", { reason: "partner" }]);
    expect((await sink.run(["do-not-contact", "get", "dnc_1", "--json"])).requests.map(line)).toEqual(["GET /v1/do-not-contact/dnc_1"]);
    const rm = await sink.run(["do-not-contact", "remove", "dnc_1", "--json"]);
    expect([rm.status, rm.requests.map(line)]).toEqual([0, ["DELETE /v1/do-not-contact/dnc_1"]]);
  });

  it.each([
    [["add"]],
    [["add", "--contact", "con_1", "--linkedin-url", "https://www.linkedin.com/in/j"]],
    [["add", "--contact", "con_1", "--reason", "bogus"]],
    [["update", "dnc_1"]],
  ])("%j is refused before any request", async (args) => {
    const r = await sink.run(["do-not-contact", ...args]);
    expect([r.status, r.requests.length]).toEqual([2, 0]);
  });
});
