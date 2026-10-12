// Last edited: 2026-10-11 20:30 PDT
// Switching the active project from the dashboard. `POST /project/switch/:slug` refuses while any
// agent is live in the current project (a restart would leave it unmanaged), then records the new
// active project and restarts the services through a `ServiceRestarter`. On Linux under systemd
// that is `systemctl --user restart marshall`, then the dashboard exits after its reply and the
// unit's `Restart=always` brings it back on the new project. Elsewhere nothing restarts: the
// reply tells the owner to do it by hand. Every command is an argv array; nothing is interpolated.

import type { Logger } from "../log.ts";
import {
  getActive,
  getProject,
  listProjects,
  ProjectError,
  projectWorkspace,
  setActive,
} from "../projects.ts";
import { html, type SafeHtml } from "./html.ts";
import { renderProjectMenu } from "./render/project-menu.ts";

export interface ServiceRestarter {
  /** True when this process may restart the services itself. */
  automatic: boolean;
  /** Restart the orchestrator. Rejects when it does not come back. */
  restartDaemon(): Promise<void>;
  /** Restart the dashboard itself. Called after the reply is sent; may end the process. */
  restartDashboard(): void;
}

/** What the page and the route need from the dashboard's start-up. */
export interface ProjectSwitchOptions {
  /** Slug this dashboard runs on, or null when MARSHALL_CONFIG fixes it (switching would do nothing). */
  current: string | null;
  restarter: ServiceRestarter;
}

export interface SwitchBody {
  ok: boolean;
  message: string;
  /** True when the page should wait for the dashboard to come back, then reload. */
  restarting: boolean;
}

export type SwitchResult = { status: number; body: SwitchBody };

const MANUAL_HINT = "Restart Marshall and the dashboard to finish switching.";

async function runArgv(argv: string[]): Promise<void> {
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(stderr.trim() || `${argv[0]} exited ${code}`);
}

export interface RestarterDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: (argv: string[]) => Promise<void>;
  exit?: (code: number) => void;
  /** How long the dashboard waits after its reply before it exits. */
  exitDelayMs?: number;
}

/**
 * Automatic only on Linux and only under systemd (`INVOCATION_ID` is set for its services): a
 * dashboard started by hand would exit and never come back.
 */
export function defaultRestarter(deps: RestarterDeps = {}): ServiceRestarter {
  const env = deps.env ?? process.env;
  const automatic = (deps.platform ?? process.platform) === "linux" && Boolean(env.INVOCATION_ID);
  const run = deps.run ?? runArgv;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return {
    automatic,
    restartDaemon: () => run(["systemctl", "--user", "restart", "marshall"]),
    restartDashboard: () => void setTimeout(() => exit(0), deps.exitDelayMs ?? 500),
  };
}

export interface SwitcherDeps extends ProjectSwitchOptions {
  /** Claims that hold a slot in this dashboard's project, read fresh. */
  liveAgents: () => number;
  log: Logger;
}

const refuse = (status: number, message: string): SwitchResult => ({
  status,
  body: { ok: false, message, restarting: false },
});

export function createProjectSwitcher(deps: SwitcherDeps): (slug: string) => Promise<SwitchResult> {
  let busy = false;
  return async (slug) => {
    const target = getProject(slug);
    if (!target) return refuse(404, "Unknown project.");
    if (deps.current === null) {
      return refuse(409, "This dashboard is fixed to one config, so it cannot switch projects.");
    }
    if (getActive()?.slug === slug)
      return refuse(409, `${target.name} is already the active project.`);
    if (busy) return refuse(409, "A switch is already in progress.");
    const live = deps.liveAgents();
    if (live > 0) {
      const them = live === 1 ? "1 agent is" : `${live} agents are`;
      return refuse(409, `${them} still working. Wait for them to finish, then switch.`);
    }
    busy = true;
    try {
      setActive(slug);
    } catch (err) {
      busy = false;
      if (err instanceof ProjectError) return refuse(404, "Unknown project.");
      throw err;
    }
    deps.log.info("dashboard.project_switch", { from: deps.current, to: slug });
    if (!deps.restarter.automatic) {
      busy = false;
      return {
        status: 200,
        body: {
          ok: true,
          message: `Switched to ${target.name}. ${MANUAL_HINT}`,
          restarting: false,
        },
      };
    }
    try {
      await deps.restarter.restartDaemon();
    } catch (err) {
      deps.log.error("dashboard.restart_failed", { error: (err as Error).message });
      deps.restarter.restartDashboard();
      return {
        status: 502,
        body: {
          ok: false,
          message: `Switched to ${target.name}, but Marshall did not restart. Run: systemctl --user restart marshall`,
          restarting: true,
        },
      };
    }
    deps.restarter.restartDashboard();
    const message = `Switched to ${target.name}. Restarting Marshall and the dashboard.`;
    return { status: 200, body: { ok: true, message, restarting: true } };
  };
}

type RouteRequest = Request & { params?: Record<string, string> };

/** The route body. `switcher` is null when the dashboard was started without project support. */
export function projectSwitchHandler(
  switcher: ReturnType<typeof createProjectSwitcher> | null,
  originOk: (req: Request) => boolean,
): (req: RouteRequest) => Promise<Response> {
  return async (req) => {
    if (!originOk(req)) return new Response("Forbidden", { status: 403 });
    if (!switcher) return refuseJson(404, "Project switching is not set up.");
    const { status, body } = await switcher(req.params?.slug ?? "");
    return Response.json(body, { status });
  };
}

function refuseJson(status: number, message: string): Response {
  return Response.json({ ok: false, message, restarting: false }, { status });
}

/** The header menu for this request. An unreadable registry hides the menu; it never breaks the page. */
export function projectMenuHtml(options: ProjectSwitchOptions | undefined): SafeHtml {
  try {
    return renderProjectMenu({
      projects: listProjects().map((p) => ({
        slug: p.slug,
        name: p.name,
        workspace: projectWorkspace(p),
      })),
      active: getActive()?.slug ?? null,
      canSwitch: options !== undefined && options.current !== null,
    });
  } catch {
    return html``;
  }
}
