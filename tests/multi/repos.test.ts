// Last edited: 2026-10-18 17:45 PDT
// Multi-repo: the `repos` config, which repos a plan names, the env an agent gets, and the claim rows.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, parseConfig } from "../../src/config.ts";
import { migrate, openDb } from "../../src/db/index.ts";
import { implementEnv, reposEnv } from "../../src/isolation.ts";
import { defaultRepo, resolveRepos } from "../../src/repos.ts";
import {
  claimBase,
  claimRepos,
  setClaimRepos,
  setRepoPr,
  siblingDirArgs,
  siblingRepos,
} from "../../src/scheduler/repos.ts";
import { beginClaim } from "../../src/scheduler/store.ts";
import { type TempHome, useTempHome } from "../helpers.ts";

let home: TempHome;

beforeEach(() => {
  home = useTempHome();
  for (const name of ["Command", "DB-Migrations", "zones"]) mkdirSync(join(home.dir, name));
});

afterEach(() => {
  home.restore();
});

const repos = () => [
  { slug: "Command", repoPath: join(home.dir, "Command"), baseBranch: "staging" },
  {
    slug: "DB-Migrations",
    repoPath: join(home.dir, "DB-Migrations"),
    baseBranch: "main",
    services: { PG_HOST_PORT: 6000 },
  },
  { slug: "zones", repoPath: join(home.dir, "zones"), baseBranch: "staging" },
];

function config(overrides: Record<string, unknown> = {}) {
  return parseConfig({ workspace: "hemut", teamId: "t", repos: repos(), ...overrides });
}

const planBody = (lines: string[]) =>
  `# P\n\n## TLDR\n\nx\n\n## Repos touched\n\n${lines.join("\n")}\n\n## Plan\n\ny\n\n## Verification\n\nz\n`;

describe("config repos", () => {
  test("repos stands in for repoPath: the first repo is the default", () => {
    const c = config();
    expect(c.repos.map((r) => r.slug)).toEqual(["Command", "DB-Migrations", "zones"]);
    expect(c.repoPath).toBe(join(home.dir, "Command"));
    expect(c.baseBranch).toBe("staging");
  });

  test("a bare repoPath becomes a one-repo list named after its folder", () => {
    const c = parseConfig({ workspace: "w", teamId: "t", repoPath: join(home.dir, "zones") });
    expect(c.repos).toEqual([
      { slug: "zones", repoPath: join(home.dir, "zones"), baseBranch: "main" },
    ]);
  });

  test("refuses both, neither, and a repeated slug", () => {
    expect(() =>
      parseConfig({ workspace: "w", teamId: "t", repoPath: home.dir, repos: repos() }),
    ).toThrow(ConfigError);
    expect(() => parseConfig({ workspace: "w", teamId: "t" })).toThrow(/repoPath or repos/);
    const dup = [repos()[0], { ...repos()[1], slug: "command" }];
    expect(() => parseConfig({ workspace: "w", teamId: "t", repos: dup })).toThrow(/unique/);
  });
});

describe("resolveRepos", () => {
  test("an issue with no plan uses the default repo alone", () => {
    const r = resolveRepos(config(), { labels: [], description: "do a thing" });
    expect(r).toMatchObject({ ok: true, explicit: false });
    expect(r.ok && r.repos.map((s) => s.repo.slug)).toEqual(["Command"]);
  });

  test("a has-plan issue gets the listed repos, primary first, with the merge order kept", () => {
    const body = planBody(["- DB-Migrations: sibling", "- Command: primary", "- zones: sibling"]);
    const r = resolveRepos(config(), { labels: ["marshall:has-plan"], description: body });
    expect(r.ok && r.explicit).toBe(true);
    expect(r.ok && r.repos.map((s) => [s.repo.slug, s.role, s.order])).toEqual([
      ["Command", "primary", 2],
      ["DB-Migrations", "sibling", 1],
      ["zones", "sibling", 3],
    ]);
  });

  test("an unknown repo is an error that names the known ones", () => {
    const body = planBody(["- Nope: primary"]);
    const r = resolveRepos(config(), { labels: ["marshall:has-plan"], description: body });
    expect(r).toEqual({
      ok: false,
      error: 'repo "Nope" is not in the config (known: Command, DB-Migrations, zones)',
    });
  });

  test("a plan body without the label is ignored", () => {
    const body = planBody(["- zones: primary"]);
    const r = resolveRepos(config(), { labels: [], description: body });
    expect(r.ok && r.repos[0]?.repo).toEqual(defaultRepo(config()));
  });
});

describe("claim_repos rows", () => {
  const db = openDb(":memory:");
  migrate(db);
  const rows = (dir: string) => [
    {
      slug: "Command",
      role: "primary" as const,
      order: 2,
      repoPath: "/r/c",
      baseBranch: "staging",
      worktreePath: `${dir}/c`,
    },
    {
      slug: "DB-Migrations",
      role: "sibling" as const,
      order: 1,
      repoPath: "/r/d",
      baseBranch: "main",
      worktreePath: `${dir}/d`,
    },
  ];

  test("round-trips in merge order, with the base of the primary and --add-dir for siblings", () => {
    beginClaim(db, "issue-1", 0, "2026-10-18T00:00:00.000Z");
    expect(claimRepos(db, "issue-1")).toEqual([]);
    expect(claimBase(db, config(), "issue-1")).toBe("staging"); // config default
    setClaimRepos(db, "issue-1", rows("/wt"));
    expect(claimRepos(db, "issue-1").map((r) => r.slug)).toEqual(["DB-Migrations", "Command"]);
    expect(siblingRepos(db, "issue-1").map((r) => r.slug)).toEqual(["DB-Migrations"]);
    expect(siblingDirArgs(db, "issue-1")).toEqual(["--add-dir", "/wt/d"]);
    expect(claimBase(db, config({ repos: [{ ...repos()[1] }] }), "issue-1")).toBe("staging");
    setRepoPr(db, "issue-1", "Command", "https://github.com/x/c/pull/1");
    expect(claimRepos(db, "issue-1").find((r) => r.slug === "Command")?.prUrl).toBe(
      "https://github.com/x/c/pull/1",
    );
    // A restart re-writes the rows with no PR yet, like claims.pr_url.
    setClaimRepos(db, "issue-1", rows("/wt"));
    expect(claimRepos(db, "issue-1").every((r) => r.prUrl === null)).toBe(true);
  });
});

describe("env for a multi-repo claim", () => {
  const claimRows = [
    {
      issueId: "i",
      slug: "DB-Migrations",
      role: "sibling" as const,
      order: 1,
      repoPath: "/r/d",
      baseBranch: "main",
      worktreePath: "/wt/d",
      prUrl: null,
    },
    {
      issueId: "i",
      slug: "Command",
      role: "primary" as const,
      order: 2,
      repoPath: "/r/c",
      baseBranch: "staging",
      worktreePath: "/wt/c",
      prUrl: null,
    },
  ];

  test("the primary repo's base, one JSON entry per repo, and each repo's ports merged", () => {
    const env = implementEnv(
      "AND-1",
      "https://l/AND-1",
      1,
      config({ portOffsetPerSlot: 100 }),
      claimRows,
    );
    expect(env.MARSHALL_BASE_BRANCH).toBe("staging");
    expect(JSON.parse(env.MARSHALL_REPOS_JSON as string)).toEqual([
      { slug: "DB-Migrations", role: "sibling", order: 1, dir: "/wt/d", base: "main" },
      { slug: "Command", role: "primary", order: 2, dir: "/wt/c", base: "staging" },
    ]);
    expect(env.PG_HOST_PORT).toBe("6100"); // DB-Migrations' own port, offset for slot 1
  });

  test("a single-repo claim gets no MARSHALL_REPOS_JSON and the config's base", () => {
    const env = reposEnv(config(), []);
    expect(env).toEqual({ MARSHALL_BASE_BRANCH: "staging" });
  });
});
