// Last edited: 2026-10-12 18:13 PDT

import { describe, expect, test } from "bun:test";
import { ciStateOf, findPrsFor, viewPr } from "../../src/phases/pr.ts";

const now = new Date("2026-09-20T18:10:00Z");
const check = (status: string, conclusion: string | null) => ({
  __typename: "CheckRun",
  status,
  conclusion,
});
const context = (state: string) => ({ __typename: "StatusContext", state });

describe("ciStateOf", () => {
  test("all completed and successful (or neutral, skipped) → green", () => {
    expect(
      ciStateOf(
        [check("COMPLETED", "SUCCESS"), check("COMPLETED", "SKIPPED"), context("SUCCESS")],
        "2026-09-20T18:00:00Z",
        now,
      ),
    ).toBe("green");
  });

  test("any failure beats any pending → red", () => {
    expect(ciStateOf([check("IN_PROGRESS", null), check("COMPLETED", "FAILURE")], "x", now)).toBe(
      "red",
    );
    expect(ciStateOf([context("ERROR")], "x", now)).toBe("red");
    expect(ciStateOf([check("COMPLETED", "CANCELLED")], "x", now)).toBe("red");
  });

  test("anything not finished → pending", () => {
    expect(ciStateOf([check("QUEUED", null), check("COMPLETED", "SUCCESS")], "x", now)).toBe(
      "pending",
    );
    expect(ciStateOf([context("PENDING")], "x", now)).toBe("pending");
  });

  test("an empty rollup is pending inside the grace period after the push, then green", () => {
    expect(ciStateOf([], "2026-09-20T18:09:00Z", now)).toBe("pending");
    expect(ciStateOf([], "2026-09-20T18:00:00Z", now)).toBe("green");
    expect(ciStateOf(undefined, "2026-09-20T18:00:00Z", now)).toBe("green");
  });
});

describe("viewPr", () => {
  test("asks gh for the four fields and folds the answer", async () => {
    const calls: string[][] = [];
    const gh = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify({
        mergedAt: null,
        state: "OPEN",
        statusCheckRollup: [check("COMPLETED", "SUCCESS")],
      });
    };
    const view = await viewPr(
      gh,
      "https://github.com/x/y/pull/1",
      "/wt",
      "2026-09-20T18:00:00Z",
      now,
    );
    expect(view).toEqual({ mergedAt: null, state: "OPEN", ci: "green", mergeable: "unknown" });
    expect(calls[0]).toEqual([
      "pr",
      "view",
      "https://github.com/x/y/pull/1",
      "--json",
      "mergedAt,state,statusCheckRollup,mergeable",
    ]);
  });
});

describe("viewPr mergeable", () => {
  const view = (mergeable: unknown) =>
    viewPr(
      async () => JSON.stringify({ state: "OPEN", statusCheckRollup: [], mergeable }),
      "https://github.com/x/y/pull/1",
      "/wt",
      "2026-09-20T18:00:00Z",
      now,
    );

  test("maps GitHub's mergeable values; anything else is unknown", async () => {
    expect((await view("MERGEABLE")).mergeable).toBe("mergeable");
    expect((await view("CONFLICTING")).mergeable).toBe("conflicting");
    expect((await view("UNKNOWN")).mergeable).toBe("unknown");
    expect((await view(undefined)).mergeable).toBe("unknown");
  });

  test("a conflicting PR with no checks still folds to green CI", async () => {
    const result = await view("CONFLICTING");
    expect(result).toMatchObject({ ci: "green", mergeable: "conflicting" });
  });
});

describe("findPrsFor", () => {
  const row = (number: number, title: string, state = "MERGED") => ({
    number,
    url: `https://github.com/example/tod/pull/${number}`,
    title,
    state,
    mergedAt: state === "MERGED" ? "2026-09-29T17:00:00Z" : null,
    headRefName: `b-${number}`,
  });

  test("searches every state by title and keeps only titles that start with `<ID>:`", async () => {
    const calls: string[][] = [];
    const rows = [
      row(1, "TOD-1: Add a timer"),
      row(2, "TOD-16: Fix the repo path"),
      row(3, "Follow-up to TOD-1: tidy"),
      row(4, "TOD-1: Retry", "OPEN"),
    ];
    const gh = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify(rows);
    };
    const found = await findPrsFor(gh, "TOD-1", "/repo");
    expect(found.map((p) => p.number)).toEqual([1, 4]);
    expect(found[0]).toEqual({
      number: 1,
      url: "https://github.com/example/tod/pull/1",
      title: "TOD-1: Add a timer",
      state: "MERGED",
      mergedAt: "2026-09-29T17:00:00Z",
    });
    expect(found[1]?.mergedAt).toBeNull();
    expect(calls[0]?.slice(0, 5)).toEqual(["pr", "list", "--state", "all", "--search"]);
    expect(calls[0]?.[5]).toBe("TOD-1 in:title");
  });
});
