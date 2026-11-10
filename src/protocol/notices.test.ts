import { describe, expect, it } from "vitest";
import { checkNotice, noticeActionCapability, parseQueuedNotice, queuedNoticeFileName } from "./notices.js";

describe("checkNotice", () => {
  it("trims the title, drops an empty body and unknown keys", () => {
    expect(checkNotice({ title: "  Run failed  ", body: "", extra: 1 })).toEqual({ ok: true, value: { title: "Run failed" } });
  });

  it.each([
    [{}, '"title"'],
    [{ title: "   " }, '"title"'],
    [{ title: "a\nb" }, "one line"],
    [{ title: "x".repeat(201) }, "200"],
    [{ title: "x", body: 3 }, '"body"'],
    [{ title: "x", body: "y".repeat(2001) }, "2000"],
    [{ title: "x", action: "open" }, '"action"'],
    [{ title: "x", action: { kind: "run" } }, '"action.kind"'],
    [{ title: "x", action: { kind: "openFile", path: "" } }, "must name a file"],
    [{ title: "x", action: { kind: "openTerminal", cwd: "", command: "a\nb" } }, "one non-empty line"],
    [{ title: "x", action: { kind: "openTerminal", cwd: "", title: " " } }, '"action.title"'],
    [{ title: "x", action: { kind: "openApp", route: 3 } }, '"action.route"'],
    [{ title: "x", action: { kind: "openApp", projectId: 3 } }, '"action.projectId"'],
    [null, "params"],
  ])("refuses %j", (params, message) => {
    const r = checkNotice(params);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid-params");
      expect(r.error.message).toContain(message);
    }
  });

  it("normalizes action paths by the workspace rule", () => {
    expect(checkNotice({ title: "x", action: { kind: "openFile", path: "a/./b/../c.md", projectId: "p" } })).toEqual({
      ok: true,
      value: { title: "x", action: { kind: "openFile", path: "a/c.md", projectId: "p" } },
    });
    expect(checkNotice({ title: "x", action: { kind: "openTerminal", command: "npm test", title: " Tests " } })).toEqual({
      ok: true,
      value: { title: "x", action: { kind: "openTerminal", cwd: "", command: "npm test", title: "Tests" } },
    });
    expect(checkNotice({ title: "x", action: { kind: "openApp" } })).toEqual({ ok: true, value: { title: "x", action: { kind: "openApp", route: "" } } });
    expect(checkNotice({ title: "x", action: { kind: "openFile", path: "/etc/hosts" } })).toMatchObject({ ok: false, error: { code: "outside-workspace" } });
    expect(checkNotice({ title: "x", action: { kind: "openFile", path: ".pomade/workspace.json" } })).toMatchObject({
      ok: false,
      error: { code: "capability-denied" },
    });
  });

  it("opening a file or a terminal needs tabs.open; the app's own tab needs nothing", () => {
    expect(noticeActionCapability({ kind: "openFile", path: "a" })).toBe("tabs.open");
    expect(noticeActionCapability({ kind: "openTerminal", cwd: "" })).toBe("tabs.open");
    expect(noticeActionCapability({ kind: "openApp", route: "" })).toBeNull();
    expect(noticeActionCapability(undefined)).toBeNull();
  });
});

describe("queued notices", () => {
  it("parses a valid file; refuses a bad source, date or notice", () => {
    expect(parseQueuedNotice({ title: "x", source: "pomade-git", postedAt: "2026-11-10T08:30:00Z" })).toEqual({
      ok: true,
      notice: { title: "x", source: "pomade-git", postedAt: "2026-11-10T08:30:00.000Z" },
    });
    expect(parseQueuedNotice({ title: "x", source: "Git", postedAt: "2026-11-10T08:30:00Z" })).toMatchObject({ ok: false });
    expect(parseQueuedNotice({ title: "x", source: "pomade-git", postedAt: "yesterday" })).toMatchObject({ ok: false });
    expect(parseQueuedNotice({ title: "", source: "pomade-git", postedAt: "2026-11-10T08:30:00Z" })).toMatchObject({ ok: false });
    expect(parseQueuedNotice([1])).toMatchObject({ ok: false });
  });

  it("file names sort by time", () => {
    const a = queuedNoticeFileName(new Date(999), "z");
    const b = queuedNoticeFileName(new Date(1000), "a");
    expect(a < b).toBe(true);
    expect(b).toBe("000000000001000-a.json");
  });
});
