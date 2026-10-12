// Last edited: 2026-10-11 20:30 PDT
// `marshall project list | use <slug> | import`: the project registry from a terminal
// (src/projects.ts). `use` only changes which project is active; the services pick it up when they
// restart. `import` registers a config file where it already is, so an existing setup (its
// MARSHALL_HOME, its Linear key in the environment) joins the registry without moving anything.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { openDb } from "../db/index.ts";
import { dbPath, expandTilde } from "../paths.ts";
import {
  addProject,
  applyActiveProject,
  getActive,
  getProject,
  listProjects,
  projectWorkspace,
  setActive,
  slugify,
  writeSecret,
} from "../projects.ts";
import { liveClaims } from "../scheduler/index.ts";

const KEY_NAME = "MARSHALL_LINEAR_API_KEY";

export function runProjectList(json: boolean): number {
  const active = getActive();
  const rows = listProjects().map((p) => ({
    slug: p.slug,
    name: p.name,
    workspace: projectWorkspace(p),
    active: p.slug === active?.slug,
  }));
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("marshall: no projects yet. Register one with `marshall project import`.");
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.slug.length), 4);
  for (const r of rows) {
    const workspace = r.workspace ?? "(config unreadable)";
    console.log(`${r.active ? "*" : " "} ${r.slug.padEnd(width)}  ${r.name}  [${workspace}]`);
  }
  return 0;
}

/** Claims that hold a slot in the project this process points at. 0 when it has no database yet. */
function liveAgentCount(): number {
  if (!existsSync(dbPath())) return 0;
  const db = openDb(dbPath());
  try {
    return liveClaims(db).length;
  } finally {
    db.close();
  }
}

export function runProjectUse(slug: string): number {
  if (!getProject(slug)) {
    console.error(`marshall project: unknown project "${slug}". Run \`marshall project list\`.`);
    return 1;
  }
  // The live-agent check reads the project that is active now, not the one being chosen.
  applyActiveProject();
  const live = getActive()?.slug === slug ? 0 : liveAgentCount();
  const record = setActive(slug);
  console.log(`marshall: active project is now ${record.slug} (${record.name}).`);
  if (live > 0) {
    console.log(
      `warning: ${live} agent${live === 1 ? " is" : "s are"} live in the previous project. After the restart nothing manages them until you switch back. Wait for them to finish first.`,
    );
  }
  console.log(
    "The services must restart to switch: systemctl --user restart marshall marshall-dashboard",
  );
  return 0;
}

export interface ProjectImportOptions {
  name?: string;
  configPath?: string;
  home?: string;
  keyFromEnv: boolean;
  env?: NodeJS.ProcessEnv;
}

export function runProjectImport(opts: ProjectImportOptions): number {
  const env = opts.env ?? process.env;
  if (!opts.name || !opts.configPath) {
    console.error("usage: marshall project import --name <name> [--home <dir>] <config-path>");
    return 2;
  }
  const configPath = resolve(expandTilde(opts.configPath));
  if (!existsSync(configPath)) {
    console.error(`marshall project: config file not found: ${configPath}`);
    return 1;
  }
  const key = env[KEY_NAME];
  if (opts.keyFromEnv && !key) {
    console.error(`marshall project: --key-from-env needs ${KEY_NAME} set in the environment.`);
    return 1;
  }
  loadConfig(configPath);
  const record = addProject({
    slug: slugify(opts.name),
    name: opts.name,
    configPath,
    ...(opts.home ? { home: resolve(expandTilde(opts.home)) } : {}),
  });
  if (opts.keyFromEnv && key) writeSecret(record.secretsPath, KEY_NAME, key);
  console.log(`marshall: imported ${record.slug} (${record.name}) from ${configPath}`);
  console.log(`home:    ${record.home}`);
  console.log(
    opts.keyFromEnv
      ? `key:     copied to ${record.secretsPath}`
      : `key:     none stored; add ${KEY_NAME} to ${record.secretsPath} or use --key-from-env`,
  );
  console.log(`active:  ${getActive()?.slug ?? "none"}`);
  return 0;
}
