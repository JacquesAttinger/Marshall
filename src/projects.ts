// Last edited: 2026-10-11 20:30 PDT
// The project registry: which projects this machine can point Marshall at, and which one is active.
// Machine-local state, never committed. Layout under `projectsRoot()`:
//   projects.json          { active: "<slug>" | null, projects: ProjectRecord[] }
//   <slug>/config.json     the Marshall config (JSONC allowed) for that project
//   <slug>/home/           that project's MARSHALL_HOME (DB, logs, hand-offs)
//   <slug>/secrets.env     KEY=value lines, mode 0600 (MARSHALL_LINEAR_API_KEY)
// `applyActiveProject()` runs once at CLI start and points this process at the active project, so
// `marshall run` and `marshall dashboard` need no per-project systemd edits: switching a project
// is "change `active`, restart the services".

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandTilde } from "./paths.ts";

export interface ProjectRecord {
  /** Lower-case id used in paths and URLs: `tic-tac-toe`. */
  slug: string;
  /** What the person calls it. */
  name: string;
  configPath: string;
  /** This project's MARSHALL_HOME. */
  home: string;
  /** `KEY=value` file with the Linear key, mode 0600. */
  secretsPath: string;
  createdAt: string;
}

interface Registry {
  active: string | null;
  projects: ProjectRecord[];
}

export class ProjectError extends Error {
  override name = "ProjectError";
}

/** `MARSHALL_PROJECTS_DIR`, else `~/.marshall-projects`. */
export function projectsRoot(): string {
  const override = process.env.MARSHALL_PROJECTS_DIR;
  return resolve(
    expandTilde(override && override.length > 0 ? override : join(homedir(), ".marshall-projects")),
  );
}

function registryPath(): string {
  return join(projectsRoot(), "projects.json");
}

/** `<root>/<slug>`: where a project's config, home and secrets live. */
export function projectDir(slug: string): string {
  return join(projectsRoot(), slug);
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `Tic Tac Toe!` -> `tic-tac-toe`. Throws when nothing usable is left. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  if (!SLUG.test(slug)) throw new ProjectError(`"${name}" does not make a usable project id`);
  return slug;
}

function readRegistry(): Registry {
  const path = registryPath();
  if (!existsSync(path)) return { active: null, projects: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Registry>;
    return {
      active: raw.active ?? null,
      projects: Array.isArray(raw.projects) ? raw.projects : [],
    };
  } catch (err) {
    throw new ProjectError(
      `Project registry is not valid JSON: ${path} (${(err as Error).message})`,
    );
  }
}

/** Temp file + rename, so a reader never sees half a registry. */
function writeRegistry(registry: Registry): void {
  mkdirSync(projectsRoot(), { recursive: true });
  const temp = `${registryPath()}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`);
  renameSync(temp, registryPath());
}

export function listProjects(): ProjectRecord[] {
  return readRegistry().projects;
}

export function getProject(slug: string): ProjectRecord | null {
  return readRegistry().projects.find((p) => p.slug === slug) ?? null;
}

/** The active project, or null when none is set or the registry is empty. */
export function getActive(): ProjectRecord | null {
  const registry = readRegistry();
  return registry.projects.find((p) => p.slug === registry.active) ?? null;
}

/** Register a project. The first one added becomes active. Throws on a duplicate slug. */
export function addProject(
  input: Pick<ProjectRecord, "slug" | "name" | "configPath"> & Partial<ProjectRecord>,
  now: Date = new Date(),
): ProjectRecord {
  if (!SLUG.test(input.slug)) throw new ProjectError(`Bad project id: ${input.slug}`);
  const registry = readRegistry();
  if (registry.projects.some((p) => p.slug === input.slug)) {
    throw new ProjectError(`Project already exists: ${input.slug}`);
  }
  const dir = projectDir(input.slug);
  const record: ProjectRecord = {
    home: join(dir, "home"),
    secretsPath: join(dir, "secrets.env"),
    createdAt: now.toISOString(),
    ...input,
  };
  registry.projects.push(record);
  if (registry.active === null) registry.active = record.slug;
  writeRegistry(registry);
  return record;
}

/** Make `slug` the active project. Takes effect when the services next start. */
export function setActive(slug: string): ProjectRecord {
  const registry = readRegistry();
  const record = registry.projects.find((p) => p.slug === slug);
  if (!record) throw new ProjectError(`Unknown project: ${slug}`);
  registry.active = slug;
  writeRegistry(registry);
  return record;
}

/**
 * The Linear workspace name in a project's config, or null when the file is missing or unreadable.
 * Reads the raw JSONC and skips full validation, so a list still works when one repoPath is gone.
 */
export function projectWorkspace(record: Pick<ProjectRecord, "configPath">): string | null {
  try {
    const raw = Bun.JSONC.parse(readFileSync(record.configPath, "utf8")) as { workspace?: unknown };
    return typeof raw.workspace === "string" && raw.workspace.length > 0 ? raw.workspace : null;
  } catch {
    return null;
  }
}

/** Parse `KEY=value` lines. Blank lines and `#` comments are skipped; quotes are not interpreted. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match && !line.trimStart().startsWith("#"))
      out[match[1] as string] = (match[2] as string).trim();
  }
  return out;
}

/** Set one key in a project's secrets file, keeping the other keys. Mode 0600. Never logged. */
export function writeSecret(secretsPath: string, key: string, value: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new ProjectError(`Bad secret name: ${key}`);
  if (/[\r\n]/.test(value)) throw new ProjectError("A secret cannot contain a newline");
  mkdirSync(join(secretsPath, ".."), { recursive: true });
  const current = existsSync(secretsPath) ? parseEnvFile(readFileSync(secretsPath, "utf8")) : {};
  current[key] = value;
  const text = `${Object.entries(current)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")}\n`;
  const temp = `${secretsPath}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, secretsPath);
}

/**
 * Point this process at the active project: MARSHALL_CONFIG, MARSHALL_HOME, and the project's
 * secrets. Does nothing when the caller chose a config (MARSHALL_CONFIG already set, or `--config`
 * given), or when no project is active. The project's Linear key replaces one Bun loaded from the
 * repo's `.env`, so a stale `.env` can never talk to the wrong workspace.
 */
export function applyActiveProject(
  env: NodeJS.ProcessEnv = process.env,
  explicitConfig?: string,
): ProjectRecord | null {
  if (explicitConfig || (env.MARSHALL_CONFIG && env.MARSHALL_CONFIG.length > 0)) return null;
  const active = getActive();
  if (!active) return null;
  env.MARSHALL_CONFIG = active.configPath;
  env.MARSHALL_HOME = active.home;
  if (existsSync(active.secretsPath)) {
    for (const [key, value] of Object.entries(
      parseEnvFile(readFileSync(active.secretsPath, "utf8")),
    )) {
      env[key] = value;
    }
  }
  return active;
}
