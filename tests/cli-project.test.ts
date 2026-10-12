// Last edited: 2026-10-11 20:30 PDT
// `marshall project list | use | import` through `dispatch`, over a temp MARSHALL_PROJECTS_DIR:
// the table and its active marker, `use` with and without a live agent in the active project,
// and `import` registering a config in place (own home, key copied from the environment only
// when asked, key never printed).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, parseArgs } from "../src/cli/index.ts";
import { migrate, openDb } from "../src/db/index.ts";
import { dbPath } from "../src/paths.ts";
import { getActive, getProject, listProjects } from "../src/projects.ts";
import { type TempHome, useTempHome } from "./helpers.ts";
import { seedClaim } from "./scheduler/helpers.ts";

const ENV_KEYS = ["MARSHALL_PROJECTS_DIR", "MARSHALL_LINEAR_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let projectsDir: string;
let home: TempHome;
let workDir: string;
const logs: string[] = [];
const errors: string[] = [];
const realLog = console.log;
const realError = console.error;

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  projectsDir = mkdtempSync(join(tmpdir(), "marshall-projects-"));
  process.env.MARSHALL_PROJECTS_DIR = projectsDir;
  delete process.env.MARSHALL_LINEAR_API_KEY;
  home = useTempHome();
  workDir = mkdtempSync(join(tmpdir(), "marshall-work-"));
  logs.length = 0;
  errors.length = 0;
  console.log = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
});

afterEach(() => {
  console.log = realLog;
  console.error = realError;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  home.restore();
  rmSync(projectsDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

/** A valid config file whose repoPath exists, so `import` can validate it. */
function writeConfig(name: string, workspace: string): string {
  const path = join(workDir, name);
  writeFileSync(path, JSON.stringify({ workspace, teamId: "team", repoPath: workDir }));
  return path;
}

async function importProject(name: string, workspace: string, extra: string[] = []) {
  const config = writeConfig(`${name}.json`, workspace);
  const code = await dispatch(["project", "import", "--name", name, ...extra, config]);
  return { code, config };
}

describe("parseArgs for project commands", () => {
  test("--name, --home, --key-from-env", () => {
    const p = parseArgs(["project", "import", "--name=Foo Bar", "--home", "/h", "--key-from-env"]);
    expect(p).toMatchObject({ name: "Foo Bar", home: "/h", keyFromEnv: true });
    expect(() => parseArgs(["--name"])).toThrow(/--name needs a value/);
    expect(parseArgs(["status"]).keyFromEnv).toBe(false);
  });
});

describe("project import", () => {
  test("registers the config in place with its own home; the first project is active", async () => {
    const { code, config } = await importProject("Tic Tac Toe", "ttt", ["--home", "~/.mh-test"]);
    expect(code).toBe(0);
    const record = getProject("tic-tac-toe");
    expect(record?.configPath).toBe(config);
    expect(record?.home).toMatch(/\.mh-test$/);
    expect(getActive()?.slug).toBe("tic-tac-toe");
    expect(logs.join("\n")).toContain("none stored");
  });

  test("--key-from-env copies the key into a 0600 secrets file and never prints it", async () => {
    process.env.MARSHALL_LINEAR_API_KEY = "lin_api_SECRET123";
    const { code } = await importProject("alpha", "a", ["--key-from-env"]);
    expect(code).toBe(0);
    const path = getProject("alpha")?.secretsPath as string;
    expect(readFileSync(path, "utf8")).toBe("MARSHALL_LINEAR_API_KEY=lin_api_SECRET123\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).not.toContain("SECRET123");
  });

  test("--key-from-env without the variable fails and registers nothing", async () => {
    const { code } = await importProject("alpha", "a", ["--key-from-env"]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("MARSHALL_LINEAR_API_KEY");
    expect(listProjects()).toEqual([]);
  });

  test("without the flag no key is stored", async () => {
    process.env.MARSHALL_LINEAR_API_KEY = "lin_api_SECRET123";
    await importProject("alpha", "a");
    expect(() => readFileSync(getProject("alpha")?.secretsPath as string)).toThrow();
  });

  test("a missing config, a missing name, and a duplicate are refused", async () => {
    expect(await dispatch(["project", "import", "--name", "x", join(workDir, "nope.json")])).toBe(
      1,
    );
    expect(await dispatch(["project", "import", join(workDir, "nope.json")])).toBe(2);
    await importProject("alpha", "a");
    await expect(importProject("alpha", "a")).rejects.toThrow("already exists");
  });

  test("an invalid config is refused before it is registered", async () => {
    const bad = join(workDir, "bad.json");
    writeFileSync(bad, JSON.stringify({ workspace: "w" }));
    await expect(dispatch(["project", "import", "--name", "bad", bad])).rejects.toThrow();
    expect(listProjects()).toEqual([]);
  });
});

describe("project list and use", () => {
  test("list shows slug, name, workspace and the active marker; --json is parseable", async () => {
    await importProject("alpha", "ws-a");
    await importProject("beta", "ws-b");
    logs.length = 0;
    expect(await dispatch(["project", "list"])).toBe(0);
    expect(logs[0]).toMatch(/^\* alpha\s+alpha\s+\[ws-a\]$/);
    expect(logs[1]).toMatch(/^ {2}beta\s+beta\s+\[ws-b\]$/);
    logs.length = 0;
    await dispatch(["project", "list", "--json"]);
    expect(JSON.parse(logs.join("\n"))).toEqual([
      { slug: "alpha", name: "alpha", workspace: "ws-a", active: true },
      { slug: "beta", name: "beta", workspace: "ws-b", active: false },
    ]);
  });

  test("list says so when the registry is empty", async () => {
    expect(await dispatch(["project", "list"])).toBe(0);
    expect(logs.join("\n")).toContain("no projects yet");
  });

  test("use switches, says to restart, and does not warn with nobody live", async () => {
    await importProject("alpha", "a");
    await importProject("beta", "b");
    logs.length = 0;
    expect(await dispatch(["project", "use", "beta"])).toBe(0);
    expect(getActive()?.slug).toBe("beta");
    expect(logs.join("\n")).toContain("restart");
    expect(logs.join("\n")).not.toContain("warning");
  });

  test("use warns when an agent is live in the previous project", async () => {
    const homeA = join(workDir, "home-a");
    await importProject("alpha", "a", ["--home", homeA]);
    await importProject("beta", "b");
    mkdirSync(homeA, { recursive: true });
    process.env.MARSHALL_HOME = homeA;
    const db = openDb(dbPath());
    migrate(db);
    seedClaim(db, { issueId: "u1", slot: 0, state: "implementing", identifier: "A-1" });
    db.close();
    delete process.env.MARSHALL_HOME;
    logs.length = 0;
    expect(await dispatch(["project", "use", "beta"])).toBe(0);
    expect(getActive()?.slug).toBe("beta");
    expect(logs.join("\n")).toContain("warning: 1 agent is live");
  });

  test("use with an unknown slug fails and changes nothing", async () => {
    await importProject("alpha", "a");
    expect(await dispatch(["project", "use", "nope"])).toBe(1);
    expect(errors.join("\n")).toContain('unknown project "nope"');
    expect(getActive()?.slug).toBe("alpha");
  });
});
