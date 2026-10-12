// Last edited: 2026-10-03 18:27 CDT
// `marshall dashboard` — serve the dashboard on 127.0.0.1:<dashboardPort> until SIGINT or SIGTERM.
// Its own process and launchd job, so the page stays up (and says "daemon down") when the daemon
// stops. It never migrates the DB and works without a Linear key (the queue then says why).

import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { loadConfig, loadEnv, resolveConfigPath } from "../config.ts";
import { createDashboardContext } from "../dashboard/context.ts";
import type { HelpInfo } from "../dashboard/render/help.ts";
import { startDashboard } from "../dashboard/server.ts";
import { createLogger } from "../log.ts";
import { marshallHome } from "../paths.ts";
import { untilSignal } from "./run.ts";

export interface DashboardOptions {
  configPath?: string;
}

const REPO_ROOT = resolve(import.meta.dir, "../..");

/** `/home/me/code/x` → `~/code/x`, so the help text works for whoever reads it. */
function tildePath(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

function helpInfo(config: Config, configPath: string): HelpInfo {
  const rel = relative(REPO_ROOT, configPath);
  return {
    sshCommand: config.sshCommand,
    repoDir: tildePath(REPO_ROOT),
    configPath: rel.startsWith("..") ? tildePath(configPath) : rel,
    marshallHome: process.env.MARSHALL_HOME ? tildePath(marshallHome()) : undefined,
    platform: process.platform,
  };
}

export async function runDashboard(opts: DashboardOptions): Promise<void> {
  const config = loadConfig(opts.configPath);
  const configPath = resolveConfigPath(opts.configPath);
  const log = createLogger({ command: "dashboard" });
  const context = createDashboardContext({
    config,
    apiKey: loadEnv().MARSHALL_LINEAR_API_KEY,
    log,
  });
  const server = startDashboard({
    port: config.dashboardPort,
    context,
    project: {
      workspace: config.workspace,
      repo: basename(config.repoPath),
      baseBranch: config.baseBranch,
    },
    help: helpInfo(config, configPath),
    log,
  });
  const url = `http://127.0.0.1:${server.port}`;
  log.info("dashboard.started", { url });
  console.log(`marshall: dashboard on ${url} (Ctrl-C to stop)`);
  const signal = await untilSignal();
  log.info("dashboard.stopping", { signal });
  await server.stop(true);
  context.close();
}
