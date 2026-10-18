// Last edited: 2026-10-18 13:17 PDT
// The committed Hemut config must keep parsing, and must keep the safety settings the runbook relies on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseConfig } from "../src/config.ts";
import { type TempHome, useTempHome } from "./helpers.ts";

const PATH = resolve(import.meta.dir, "..", "marshall.hemut.config.json");

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.restore();
});

/** The file's JSONC with its `~/code/hemut3` paths pointed at a temp folder that has each repo. */
function load() {
  const raw = Bun.JSONC.parse(readFileSync(PATH, "utf8")) as {
    repos: { slug: string; repoPath: string }[];
  };
  for (const repo of raw.repos) {
    repo.repoPath = join(home.dir, repo.slug);
    mkdirSync(repo.repoPath);
  }
  return raw;
}

describe("marshall.hemut.config.json", () => {
  test("parses, with every repo PR going into staging", () => {
    const config = parseConfig(load(), PATH);
    expect(config.repos.map((r) => r.slug)).toEqual([
      "Command",
      "DB-Migrations",
      "QuoteFlow_Backend",
      "RFP-Module",
      "tracking_backend",
    ]);
    expect(config.repos.every((r) => r.baseBranch === "staging")).toBe(true);
    expect(config.baseBranch).toBe("staging");
  });

  test("is opt-in, uses the Hemut implementer, and has room for long sub-agent runs", () => {
    const config = parseConfig(load(), PATH);
    expect(config.pickup).toBe("labeled");
    expect(config.pickupLabel).toBe("marshall:queued");
    expect(config.implementSkill).toBe("implement-hemut");
    expect(config.issueTimeoutHours).toBeGreaterThanOrEqual(6);
    expect(config.stallMinutes).toBeGreaterThanOrEqual(30);
    expect(config.dailyStartCap).toBeLessThanOrEqual(4);
  });

  test("never ships a real team id: the placeholder has to be replaced on purpose", () => {
    expect(parseConfig(load(), PATH).teamId).toStartWith("REPLACE-WITH");
  });
});
