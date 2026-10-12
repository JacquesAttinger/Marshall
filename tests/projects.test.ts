// Last edited: 2026-10-11 20:00 PDT

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  applyActiveProject,
  getActive,
  listProjects,
  ProjectError,
  parseEnvFile,
  projectDir,
  setActive,
  slugify,
  writeSecret,
} from "../src/projects.ts";

let dir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.MARSHALL_PROJECTS_DIR;
  dir = mkdtempSync(join(tmpdir(), "marshall-projects-"));
  process.env.MARSHALL_PROJECTS_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.MARSHALL_PROJECTS_DIR;
  else process.env.MARSHALL_PROJECTS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

const add = (slug: string) =>
  addProject({ slug, name: slug, configPath: join(projectDir(slug), "config.json") });

describe("registry", () => {
  test("empty at first; the first project added becomes active", () => {
    expect(listProjects()).toEqual([]);
    expect(getActive()).toBeNull();
    add("alpha");
    add("beta");
    expect(listProjects().map((p) => p.slug)).toEqual(["alpha", "beta"]);
    expect(getActive()?.slug).toBe("alpha");
  });

  test("setActive switches; an unknown slug and a duplicate throw", () => {
    add("alpha");
    add("beta");
    expect(setActive("beta").slug).toBe("beta");
    expect(getActive()?.slug).toBe("beta");
    expect(() => setActive("nope")).toThrow(ProjectError);
    expect(() => add("alpha")).toThrow("already exists");
  });

  test("records default home and secrets paths under the project folder", () => {
    const p = add("alpha");
    expect(p.home).toBe(join(projectDir("alpha"), "home"));
    expect(p.secretsPath).toBe(join(projectDir("alpha"), "secrets.env"));
  });

  test("a damaged registry is reported, not replaced", () => {
    writeFileSync(join(dir, "projects.json"), "{oops");
    expect(() => listProjects()).toThrow("not valid JSON");
  });
});

describe("slugify", () => {
  test("makes ids from names and rejects empty results", () => {
    expect(slugify("Tic Tac Toe!")).toBe("tic-tac-toe");
    expect(slugify("  --A_b--  ")).toBe("a-b");
    expect(() => slugify("!!!")).toThrow(ProjectError);
  });
});

describe("secrets", () => {
  test("writeSecret keeps other keys, is mode 0600, and parseEnvFile reads it back", () => {
    const path = join(projectDir("alpha"), "secrets.env");
    writeSecret(path, "MARSHALL_LINEAR_API_KEY", "lin_api_x");
    writeSecret(path, "OTHER", "1");
    writeSecret(path, "MARSHALL_LINEAR_API_KEY", "lin_api_y");
    expect(parseEnvFile(readFileSync(path, "utf8"))).toEqual({
      MARSHALL_LINEAR_API_KEY: "lin_api_y",
      OTHER: "1",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a newline in a value or a bad name is refused", () => {
    const path = join(dir, "s.env");
    expect(() => writeSecret(path, "K", "a\nb")).toThrow(ProjectError);
    expect(() => writeSecret(path, "bad-name", "x")).toThrow(ProjectError);
  });
});

describe("applyActiveProject", () => {
  test("points the env at the active project and its key beats one from .env", () => {
    const p = add("alpha");
    writeSecret(p.secretsPath, "MARSHALL_LINEAR_API_KEY", "from-project");
    const env: NodeJS.ProcessEnv = { MARSHALL_LINEAR_API_KEY: "from-dotenv" };
    expect(applyActiveProject(env)?.slug).toBe("alpha");
    expect(env.MARSHALL_CONFIG).toBe(p.configPath);
    expect(env.MARSHALL_HOME).toBe(p.home);
    expect(env.MARSHALL_LINEAR_API_KEY).toBe("from-project");
  });

  test("an explicit config (env or flag) or no active project changes nothing", () => {
    const env1: NodeJS.ProcessEnv = {};
    expect(applyActiveProject(env1)).toBeNull();
    add("alpha");
    const env2: NodeJS.ProcessEnv = { MARSHALL_CONFIG: "/x.json" };
    expect(applyActiveProject(env2)).toBeNull();
    expect(env2).toEqual({ MARSHALL_CONFIG: "/x.json" });
    const env3: NodeJS.ProcessEnv = {};
    expect(applyActiveProject(env3, "/y.json")).toBeNull();
    expect(env3).toEqual({});
  });
});
