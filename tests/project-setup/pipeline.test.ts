// Last edited: 2026-10-11 21:40 PDT
// The "add a project" pipeline with fake Linear, fake `gh`/`git`, and a temp file system: the happy
// paths (new repo, existing repo), a bad key, a workspace with several teams, hostile repo names,
// a re-run, a name clash, and a canary key that must never leave secrets.env.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createProject } from "../../src/project-setup/pipeline.ts";
import { InputError } from "../../src/project-setup/validate.ts";
import { getActive, listProjects, projectDir } from "../../src/projects.ts";
import { graphqlErrors, httpStatus } from "../linear/fake-linear.ts";
import { CANARY, makeRig, newRepoInput, type Rig } from "./helpers.ts";

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.cleanup());

const cmd = (r: Rig) => r.commands.map((c) => c.join(" "));

describe("happy paths", () => {
  test("new repo: creates, clones, sets up Linear, trusts, writes config, registers", async () => {
    const result = await createProject(newRepoInput(), rig.deps);
    expect(result.steps.map((s) => [s.step, s.ok])).toEqual([
      ["Check the Linear key", true],
      ["Check the project name", true],
      ["Save the key", true],
      ["Get the repo", true],
      ["Set up Linear", true],
      ["Trust the repo", true],
      ["Write the config", true],
      ["Set up the database", true],
    ]);
    expect(result.ok).toBe(true);
    expect(result.workspace).toBe("tictactoe1514");
    const repoPath = join(rig.codeDir, "tic-tac-toe");
    expect(cmd(rig)).toContain("gh repo create jacques/tic-tac-toe --private --add-readme");
    expect(cmd(rig)).toContain(`gh repo clone jacques/tic-tac-toe ${repoPath}`);
    expect(rig.trusted).toEqual([repoPath]);

    const config = JSON.parse(readFileSync(join(projectDir("tic-tac-toe"), "config.json"), "utf8"));
    expect(config).toMatchObject({
      workspace: "tictactoe1514",
      teamId: "team-1",
      repoPath,
      baseBranch: "main",
      maxAgents: 3,
      dashboardPort: 7777,
      sshCommand: "ssh me@vm",
    });
    const secrets = join(projectDir("tic-tac-toe"), "secrets.env");
    expect(readFileSync(secrets, "utf8")).toBe(`MARSHALL_LINEAR_API_KEY=${CANARY}\n`);
    expect(statSync(secrets).mode & 0o777).toBe(0o600);
    expect(getActive()?.slug).toBe("tic-tac-toe");
    expect(result.active).toBe(true);
    expect(rig.linear.callsFor("TeamMeta")).toHaveLength(1);
  });

  test("existing repo by URL: clones owner/name, never creates", async () => {
    const result = await createProject(
      newRepoInput({ repo: { mode: "existing", url: "https://github.com/octo/widgets.git" } }),
      rig.deps,
    );
    expect(result.ok).toBe(true);
    expect(cmd(rig).some((c) => c.startsWith("gh repo create"))).toBe(false);
    expect(cmd(rig)).toContain(`gh repo clone octo/widgets ${join(rig.codeDir, "widgets")}`);
  });

  test("a second project is added but does not become active; it inherits the active config", async () => {
    await createProject(newRepoInput(), rig.deps);
    const second = await createProject(
      newRepoInput({ name: "Other", repo: { mode: "existing", url: "octo/widgets" } }),
      rig.deps,
    );
    expect(second.ok).toBe(true);
    expect(second.active).toBe(false);
    expect(listProjects().map((p) => p.slug)).toEqual(["tic-tac-toe", "other"]);
    expect(getActive()?.slug).toBe("tic-tac-toe");
  });
});

describe("key and teams", () => {
  test("a rejected key stops at step 1 and writes nothing", async () => {
    rig.cleanup();
    rig = makeRig({
      linear: {
        KeyCheck: () => httpStatus(401, { errors: [{ message: "Authentication required" }] }),
      },
    });
    const result = await createProject(newRepoInput(), rig.deps);
    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.detail).toContain("did not accept");
    expect(existsSync(projectDir("tic-tac-toe"))).toBe(false);
    expect(rig.commands).toEqual([]);
  });

  test("several teams and no teamId: returns the list and stores nothing", async () => {
    rig.cleanup();
    rig = makeRig({
      teams: [
        { id: "t1", key: "AAA", name: "Alpha" },
        { id: "t2", key: "BBB", name: "Beta" },
      ],
    });
    const result = await createProject(newRepoInput(), rig.deps);
    expect(result.ok).toBe(false);
    expect(result.needsTeam).toBe(true);
    expect(result.teams?.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(existsSync(projectDir("tic-tac-toe"))).toBe(false);

    const chosen = await createProject(newRepoInput({ teamId: "t2" }), rig.deps);
    expect(chosen.ok).toBe(true);
    expect(
      JSON.parse(readFileSync(join(projectDir("tic-tac-toe"), "config.json"), "utf8")).teamId,
    ).toBe("t2");
  });

  test("a teamId from another workspace is refused", async () => {
    const result = await createProject(newRepoInput({ teamId: "nope" }), rig.deps);
    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain("not in this Linear workspace");
  });
});

describe("hostile input", () => {
  const bad = [
    "a b",
    "x;rm -rf ~",
    "$(whoami)",
    "../evil",
    "a/b",
    "..",
    ".hidden",
    "--upload-pack=x",
    "-rf",
    "repo.git",
    "name\nnewline",
    "a".repeat(101),
  ];
  for (const name of bad) {
    test(`new repo name ${JSON.stringify(name).slice(0, 30)} is refused before any command runs`, async () => {
      await expect(
        createProject(newRepoInput({ repo: { mode: "new", name } }), rig.deps),
      ).rejects.toBeInstanceOf(InputError);
      expect(rig.commands).toEqual([]);
      expect(rig.linear.calls).toEqual([]);
    });
  }

  const badExisting = [
    "https://evil.com/o/n",
    "http://github.com/o/n",
    "https://github.com/o/n/extra",
    "o/..",
    "o/a b",
    "-o/n",
    "o/n;ls",
    "git@github.com:o/n.git",
    "file:///etc/passwd",
    "justaname",
  ];
  for (const url of badExisting) {
    test(`existing repo ${JSON.stringify(url)} is refused`, async () => {
      await expect(
        createProject(newRepoInput({ repo: { mode: "existing", url } }), rig.deps),
      ).rejects.toBeInstanceOf(InputError);
      expect(rig.commands).toEqual([]);
    });
  }

  test("bad bodies are refused", async () => {
    for (const body of [
      null,
      "x",
      { ...newRepoInput(), name: "" },
      { ...newRepoInput(), linearApiKey: "has space in it" },
      { ...newRepoInput(), repo: undefined },
      { ...newRepoInput(), name: "!!!" },
    ]) {
      await expect(createProject(body, rig.deps)).rejects.toBeInstanceOf(InputError);
    }
  });

  test("a folder that is not a clone of this repo stops the run", async () => {
    mkdirSync(join(rig.codeDir, "tic-tac-toe", ".git"), { recursive: true });
    rig.answer("git -C", { stdout: "https://github.com/someone/else.git\n" });
    const result = await createProject(newRepoInput(), rig.deps);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)?.detail).toContain("not a clone of jacques/tic-tac-toe");
  });
});

describe("re-run", () => {
  test("every step that was done says so, and nothing is duplicated", async () => {
    await createProject(newRepoInput(), rig.deps);
    const before = cmd(rig).filter((c) => c.startsWith("gh repo")).length;
    const again = await createProject(newRepoInput(), rig.deps);
    expect(again.ok).toBe(true);
    for (const s of again.steps.slice(1)) expect(s.detail).toStartWith("Already done");
    expect(cmd(rig).filter((c) => c.startsWith("gh repo")).length).toBe(before);
    expect(listProjects()).toHaveLength(1);
    expect(rig.linear.callsFor("CreateState")).toHaveLength(0);
  });

  test("a failed clone can be retried: the repo that was created is reused", async () => {
    rig.answer("gh repo clone", { code: 1, stderr: "network down" });
    const failed = await createProject(newRepoInput(), rig.deps);
    expect(failed.ok).toBe(false);
    expect(failed.steps.at(-1)?.detail).toContain("network down");
    expect(listProjects()).toEqual([]);
    rig.answer("gh repo clone", null);
    rig.answer("gh repo view", { code: 0 });
    const retry = await createProject(newRepoInput(), rig.deps);
    expect(retry.ok).toBe(true);
    expect(cmd(rig).filter((c) => c.startsWith("gh repo create"))).toHaveLength(1);
  });

  test("the same name for a different repo is refused", async () => {
    await createProject(newRepoInput(), rig.deps);
    const clash = await createProject(
      newRepoInput({ repo: { mode: "existing", url: "octo/widgets" } }),
      rig.deps,
    );
    expect(clash.ok).toBe(false);
    expect(clash.steps.at(-1)?.detail).toContain("already exists");
    expect(listProjects()).toHaveLength(1);
  });
});

describe("the key never leaks", () => {
  test("not in results, logs, the config, or the registry; only in secrets.env", async () => {
    rig.answer("gh repo clone", { code: 1, stderr: `fatal: bad credential ${CANARY}` });
    const failed = await createProject(newRepoInput(), rig.deps);
    rig.answer("gh repo clone", null);
    const ok = await createProject(newRepoInput(), rig.deps);
    const out = JSON.stringify([failed, ok, rig.lines, rig.commands]);
    expect(out).not.toContain(CANARY);
    const dir = projectDir("tic-tac-toe");
    expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(CANARY);
    expect(readFileSync(join(dir, "..", "projects.json"), "utf8")).not.toContain(CANARY);
    expect(readFileSync(join(dir, "secrets.env"), "utf8")).toContain(CANARY);
  });

  test("a Linear error that echoes the key is redacted", async () => {
    rig.cleanup();
    rig = makeRig({ linear: { TeamMeta: () => graphqlErrors(`bad token ${CANARY}`) } });
    const result = await createProject(newRepoInput(), rig.deps);
    expect(result.ok).toBe(false);
    expect(JSON.stringify([result, rig.lines])).not.toContain(CANARY);
  });
});
