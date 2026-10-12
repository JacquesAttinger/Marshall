// Last edited: 2026-10-11 21:45 PDT
// The "add project" routes on a real server (port 0) with fake pipeline dependencies: Host and
// Origin guards, body checks, the key check storing nothing, one create at a time, and no key in
// any response or log line.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { Server } from "bun";
import { parseConfig } from "../../src/config.ts";
import { createDashboardContext, type DashboardContext } from "../../src/dashboard/context.ts";
import { startDashboard } from "../../src/dashboard/server.ts";
import { projectDir } from "../../src/projects.ts";
import { recordingLogger, type TempHome, useTempHome } from "../helpers.ts";
import { httpStatus } from "../linear/fake-linear.ts";
import { CANARY, makeRig, newRepoInput, type Rig } from "../project-setup/helpers.ts";
import { fakeClient } from "../scheduler/fake-client.ts";

let home: TempHome;
let rig: Rig;
let server: Server<undefined>;
let context: DashboardContext;
let base: string;
let host: string;
let logLines: ReturnType<typeof recordingLogger>["lines"];

function start(): void {
  const config = parseConfig({ workspace: "w", teamId: "t", repoPath: home.dir });
  context = createDashboardContext({
    config,
    apiKey: "key",
    log: recordingLogger().log,
    connect: async () => fakeClient([]),
    listSessions: async () => [],
    daemon: { platform: "linux" },
  });
  const logger = recordingLogger();
  logLines = logger.lines;
  server = startDashboard({
    port: 0,
    context,
    project: { workspace: "w", repo: "r", baseBranch: "main" },
    help: { repoDir: "~/r", configPath: "c.json", platform: "linux" },
    log: logger.log,
    setupDeps: rig.deps,
  });
  host = `127.0.0.1:${server.port}`;
  base = `http://${host}`;
}

beforeEach(() => {
  home = useTempHome();
  rig = makeRig();
  start();
});

afterEach(async () => {
  await server.stop(true);
  context.close();
  rig.cleanup();
  home.restore();
});

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { Origin: base, "Content-Type": "application/json" },
) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { Host: host, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("guards", () => {
  for (const path of ["/projects/validate-key", "/projects"]) {
    test(`${path}: a foreign or missing Origin is 403, a foreign Host is 403`, async () => {
      const json = { "Content-Type": "application/json" };
      expect((await post(path, {}, { ...json, Origin: "https://evil.example" })).status).toBe(403);
      expect((await post(path, {}, json)).status).toBe(403);
      const badHost = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { Host: "evil.example", Origin: "http://evil.example", ...json },
        body: "{}",
      });
      expect(badHost.status).toBe(403);
      expect(rig.linear.calls).toEqual([]);
    });
  }

  test("bad bodies: not JSON 400, wrong content type 400, array 400, too big 413", async () => {
    expect((await post("/projects", "{nope")).status).toBe(400);
    expect(
      (await post("/projects", "{}", { Origin: base, "Content-Type": "text/plain" })).status,
    ).toBe(400);
    expect((await post("/projects", "[]")).status).toBe(400);
    const big = await post("/projects", JSON.stringify({ name: "x".repeat(10_000) }));
    expect(big.status).toBe(413);
  });

  test("a body without a declared length is still capped", async () => {
    const res = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { Host: host, Origin: base, "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"name":"${"x".repeat(9000)}"}`));
          controller.close();
        },
      }),
    });
    expect(res.status).toBe(413);
  });

  test("the script and stylesheet are served", async () => {
    for (const name of ["add-project.js", "add-project.css"]) {
      const res = await fetch(`${base}/assets/${name}`, { headers: { Host: host } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    }
  });
});

describe("POST /projects/validate-key", () => {
  test("returns the workspace and teams and stores nothing", async () => {
    const res = await post("/projects/validate-key", { key: CANARY });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspace: "tictactoe1514",
      teams: [{ id: "team-1", key: "TIC", name: "TicTacToe" }],
    });
    expect(existsSync(projectDir("tic-tac-toe"))).toBe(false);
    expect(rig.commands).toEqual([]);
  });

  test("a malformed key is 400 and never reaches Linear; a rejected key is 422", async () => {
    expect((await post("/projects/validate-key", { key: "short" })).status).toBe(400);
    expect((await post("/projects/validate-key", {})).status).toBe(400);
    expect(rig.linear.calls).toEqual([]);
    rig.cleanup();
    rig = makeRig({ linear: { KeyCheck: () => httpStatus(401, { errors: [{ message: "no" }] }) } });
    await server.stop(true);
    context.close();
    start();
    const res = await post("/projects/validate-key", { key: CANARY });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain(CANARY);
  });
});

describe("POST /projects", () => {
  test("runs the pipeline and logs the project name and steps, not the key", async () => {
    const res = await post("/projects", newRepoInput());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; steps: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.steps).toHaveLength(7);
    expect(JSON.stringify([body, logLines])).not.toContain(CANARY);
    const logged = logLines.find((l) => l.event === "dashboard.add_project");
    expect(logged?.fields.project).toBe("Tic Tac Toe");
    expect(existsSync(projectDir("tic-tac-toe"))).toBe(true);
  });

  test("a hostile repo name is 400 with a plain message", async () => {
    const res = await post("/projects", newRepoInput({ repo: { mode: "new", name: "a;b" } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(rig.commands).toEqual([]);
  });

  test("a second create while one runs gets 409, and the first still finishes", async () => {
    const gate = rig.gate();
    const first = post("/projects", newRepoInput());
    while (!rig.commands.some((c) => c[2] === "create")) await Bun.sleep(5);
    const second = await post(
      "/projects",
      newRepoInput({ name: "Other", repo: { mode: "new", name: "other" } }),
    );
    expect(second.status).toBe(409);
    gate.release();
    expect((await first).status).toBe(200);
    const third = await post(
      "/projects",
      newRepoInput({ name: "Other", repo: { mode: "new", name: "other" } }),
    );
    expect(third.status).toBe(200);
  });

  test("an unexpected crash is a generic 500 with no stack and no key", async () => {
    rig.deps.gql = () => {
      throw new Error(`boom with ${CANARY}`);
    };
    const res = await post("/projects", newRepoInput());
    const text = await res.text();
    expect(text).not.toContain("boom");
    expect(text).not.toContain(CANARY);
    expect(JSON.stringify(logLines)).not.toContain(CANARY);
  });
});
