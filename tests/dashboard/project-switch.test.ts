// Last edited: 2026-10-11 20:30 PDT
// Switching projects from the dashboard: the guards (Host, Origin), a bad slug, the refusal while
// an agent is live, the success path with a fake ServiceRestarter, a restart that fails, the
// manual path (no restart), a dashboard fixed by MARSHALL_CONFIG, the default restarter's argv
// and systemd detection, and the project menu on the page. Nothing here restarts a real service.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { parseConfig } from "../../src/config.ts";
import { createDashboardContext, type DashboardContext } from "../../src/dashboard/context.ts";
import {
  defaultRestarter,
  type ProjectSwitchOptions,
  type ServiceRestarter,
} from "../../src/dashboard/project-routes.ts";
import { startDashboard } from "../../src/dashboard/server.ts";
import { migrate, openDb } from "../../src/db/index.ts";
import { dbPath } from "../../src/paths.ts";
import { addProject, getActive } from "../../src/projects.ts";
import { recordingLogger, type TempHome, useTempHome } from "../helpers.ts";
import { fakeClient } from "../scheduler/fake-client.ts";
import { seedClaim } from "../scheduler/helpers.ts";

let home: TempHome;
let projectsDir: string;
let previousProjectsDir: string | undefined;
let server: Server<undefined> | null;
let context: DashboardContext;
let base: string;
let host: string;
let calls: string[];

function fakeRestarter(automatic: boolean, failDaemon = false): ServiceRestarter {
  return {
    automatic,
    restartDaemon: async () => {
      calls.push("daemon");
      if (failDaemon) throw new Error("Unit marshall.service not found");
    },
    restartDashboard: () => void calls.push("dashboard"),
  };
}

function start(projects?: ProjectSwitchOptions): void {
  const config = parseConfig({ workspace: "w", teamId: "t", repoPath: home.dir, maxAgents: 3 });
  context = createDashboardContext({
    config,
    apiKey: "key",
    log: recordingLogger().log,
    connect: async () => fakeClient([]),
    listSessions: async () => [],
    daemon: { platform: "linux" },
  });
  server = startDashboard({
    port: 0,
    context,
    project: { workspace: "w", repo: "r", baseBranch: "main" },
    help: { repoDir: "~/r", configPath: "c.json", platform: "linux" },
    projects,
    log: recordingLogger().log,
  });
  host = `127.0.0.1:${server.port}`;
  base = `http://${host}`;
}

function seedLive(): void {
  mkdirSync(dirname(dbPath()), { recursive: true });
  const db = openDb(dbPath());
  migrate(db);
  seedClaim(db, { issueId: "u1", slot: 0, state: "implementing", identifier: "TOD-1" });
  db.close();
}

const register = (slug: string, name: string, workspace: string) => {
  const configPath = join(projectsDir, `${slug}.json`);
  writeFileSync(configPath, JSON.stringify({ workspace, teamId: "t", repoPath: home.dir }));
  addProject({ slug, name, configPath });
};

const post = (slug: string, origin: string | null = base, hostHeader = host) =>
  fetch(`${base}/project/switch/${slug}`, {
    method: "POST",
    headers: { Host: hostHeader, ...(origin ? { Origin: origin } : {}) },
  });

beforeEach(() => {
  home = useTempHome();
  server = null;
  calls = [];
  previousProjectsDir = process.env.MARSHALL_PROJECTS_DIR;
  projectsDir = mkdtempSync(join(tmpdir(), "marshall-projects-"));
  process.env.MARSHALL_PROJECTS_DIR = projectsDir;
  register("alpha", "Alpha <b>", "ws-alpha");
  register("beta", "Beta", "ws-beta");
});

afterEach(async () => {
  await server?.stop(true);
  context?.close();
  home.restore();
  if (previousProjectsDir === undefined) delete process.env.MARSHALL_PROJECTS_DIR;
  else process.env.MARSHALL_PROJECTS_DIR = previousProjectsDir;
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("POST /project/switch/:slug", () => {
  test("success: records the new active project, restarts the daemon, then the dashboard", async () => {
    start({ current: "alpha", restarter: fakeRestarter(true) });
    const res = await post("beta");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, restarting: true });
    expect(getActive()?.slug).toBe("beta");
    expect(calls).toEqual(["daemon", "dashboard"]);
  });

  test("refused with 409 while an agent is live: nothing changes, nothing restarts", async () => {
    seedLive();
    start({ current: "alpha", restarter: fakeRestarter(true) });
    const res = await post("beta");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      message: expect.stringMatching(/1 agent is still working/),
    });
    expect(getActive()?.slug).toBe("alpha");
    expect(calls).toEqual([]);
  });

  test("a bad or unknown slug is 404; the active project is 409", async () => {
    start({ current: "alpha", restarter: fakeRestarter(true) });
    expect((await post("nope")).status).toBe(404);
    expect((await post("..%2F..%2Fetc")).status).toBe(404);
    expect((await post("alpha")).status).toBe(409);
    expect(calls).toEqual([]);
  });

  test("a wrong or missing Origin, or a foreign Host, is 403 and changes nothing", async () => {
    start({ current: "alpha", restarter: fakeRestarter(true) });
    expect((await post("beta", "https://evil.com")).status).toBe(403);
    expect((await post("beta", null)).status).toBe(403);
    expect((await post("beta", "http://evil.com", "evil.com")).status).toBe(403);
    expect(getActive()?.slug).toBe("alpha");
    expect(calls).toEqual([]);
  });

  test("manual platform: switches, restarts nothing, and says to restart", async () => {
    start({ current: "alpha", restarter: fakeRestarter(false) });
    const body = (await (await post("beta")).json()) as {
      ok: boolean;
      restarting: boolean;
      message: string;
    };
    expect(body).toMatchObject({ ok: true, restarting: false });
    expect(body.message).toContain("Restart");
    expect(getActive()?.slug).toBe("beta");
    expect(calls).toEqual([]);
  });
});

describe("POST /project/switch/:slug, other outcomes", () => {
  test("a daemon restart that fails is 502 with the command to run, and the dashboard still restarts", async () => {
    start({ current: "alpha", restarter: fakeRestarter(true, true) });
    const res = await post("beta");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      ok: false,
      restarting: true,
      message: expect.stringContaining("systemctl --user restart marshall"),
    });
    expect(calls).toEqual(["daemon", "dashboard"]);
  });

  test("a dashboard fixed by MARSHALL_CONFIG cannot switch", async () => {
    start({ current: null, restarter: fakeRestarter(true) });
    const res = await post("beta");
    expect(res.status).toBe(409);
    expect(getActive()?.slug).toBe("alpha");
    expect(calls).toEqual([]);
  });

  test("a dashboard started without project support answers 404", async () => {
    start(undefined);
    expect((await post("beta")).status).toBe(404);
  });
});

describe("the project menu on the page", () => {
  test("lists every project, escapes names, marks the active one, offers Switch on the others", async () => {
    start({ current: "alpha", restarter: fakeRestarter(true) });
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain("project-menu");
    expect(page).toContain("Alpha &lt;b&gt;");
    expect(page).not.toContain("Alpha <b>");
    expect(page).toContain("Linear ws-beta");
    expect(page).toContain('data-switch="beta"');
    expect(page).not.toContain('data-switch="alpha"');
    expect(page).not.toContain("<script>");
  });

  test("a fixed dashboard shows the list without Switch buttons", async () => {
    start({ current: null, restarter: fakeRestarter(true) });
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toContain("fixed to one config");
    expect(page).not.toContain("data-switch=");
  });

  test("no projects registered: no menu", async () => {
    rmSync(join(projectsDir, "projects.json"));
    start({ current: null, restarter: fakeRestarter(true) });
    expect(await (await fetch(`${base}/`)).text()).not.toContain("project-menu");
  });
});

describe("defaultRestarter", () => {
  test("automatic only on Linux under systemd", () => {
    expect(defaultRestarter({ platform: "linux", env: { INVOCATION_ID: "x" } }).automatic).toBe(
      true,
    );
    expect(defaultRestarter({ platform: "linux", env: {} }).automatic).toBe(false);
    expect(defaultRestarter({ platform: "darwin", env: { INVOCATION_ID: "x" } }).automatic).toBe(
      false,
    );
  });

  test("restarts the daemon with an argv array and exits the process after a delay", async () => {
    const ran: string[][] = [];
    const exits: number[] = [];
    const restarter = defaultRestarter({
      platform: "linux",
      env: { INVOCATION_ID: "x" },
      run: async (argv) => void ran.push(argv),
      exit: (code) => void exits.push(code),
      exitDelayMs: 5,
    });
    await restarter.restartDaemon();
    expect(ran).toEqual([["systemctl", "--user", "restart", "marshall"]]);
    restarter.restartDashboard();
    expect(exits).toEqual([]);
    await Bun.sleep(30);
    expect(exits).toEqual([0]);
  });
});
