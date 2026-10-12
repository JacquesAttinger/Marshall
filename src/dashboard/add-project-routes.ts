// Last edited: 2026-10-11 21:10 PDT
// The "add a project" routes: POST /projects/validate-key (reads Linear, stores nothing) and
// POST /projects (runs the pipeline), plus this feature's script and stylesheet. Both POSTs
// pass the server's Host guard and an Origin check, take a small JSON body, and answer with
// a generic message on any surprise. Only one create runs at a time; a second gets 409.
// The key is read from the body and never logged or echoed.

import { join } from "node:path";
import type { Logger } from "../log.ts";
import { defaultSetupDeps } from "../project-setup/deps.ts";
import { checkLinearKey, KeyCheckError } from "../project-setup/key-check.ts";
import { createProject, redact } from "../project-setup/pipeline.ts";
import type { SetupDeps } from "../project-setup/types.ts";
import { checkApiKey, InputError } from "../project-setup/validate.ts";

type Handler = (req: Request & { params?: Record<string, string> }) => Response | Promise<Response>;

export interface AddProjectRouteOptions {
  /** The server's wrapper: Host allow-list, security headers, plain 500. */
  guard: (handler: Handler) => Handler;
  originMatches: (origin: string | null, host: string | null) => boolean;
  log: Logger;
  /** True when the project menu's Switch route works here, so the form may offer it. */
  canSwitch?: boolean;
  /** Tests pass fakes; production builds the real ones on first use. */
  deps?: SetupDeps;
}

/** Large enough for any form; small enough that nobody can use it to fill memory. */
export const MAX_BODY_BYTES = 4096;
const ASSETS = join(import.meta.dir, "assets");
const GENERIC_FAILURE = "Something went wrong. Check the dashboard log.";

const fail = (message: string, status: number) => Response.json({ ok: false, message }, { status });

/** Read at most `cap` bytes and parse JSON. Null when it is too big or not a JSON object. */
async function readJson(
  req: Request,
  cap: number,
): Promise<Record<string, unknown> | "big" | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > cap) return "big";
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json"))
    return null;
  const reader = req.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return "big";
    }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asset(name: string, type: string): Handler {
  return () => new Response(Bun.file(join(ASSETS, name)), { headers: { "Content-Type": type } });
}

export function addProjectRoutes(opts: AddProjectRouteOptions) {
  const { guard, log } = opts;
  let deps = opts.deps;
  const getDeps = () => {
    deps ??= defaultSetupDeps(log);
    return deps;
  };
  let busy = false;

  /** Origin, then body. Returns the body, or the error response to send. */
  async function intake(req: Request): Promise<Record<string, unknown> | Response> {
    if (!opts.originMatches(req.headers.get("origin"), req.headers.get("host"))) {
      return new Response("Forbidden", { status: 403 });
    }
    const body = await readJson(req, MAX_BODY_BYTES);
    if (body === "big") return fail("The request is too large.", 413);
    if (!body) return fail("Send a JSON object.", 400);
    return body;
  }

  const validateKey: Handler = async (req) => {
    const body = await intake(req);
    if (body instanceof Response) return body;
    let key = "";
    try {
      key = checkApiKey(body.key);
      const info = await checkLinearKey(getDeps(), key);
      return Response.json({ ok: true, workspace: info.workspace, teams: info.teams });
    } catch (err) {
      if (err instanceof InputError) return fail(err.message, 400);
      if (err instanceof KeyCheckError) return fail(err.message, 422);
      log.error("dashboard.validate_key_failed", { error: redact((err as Error).message, key) });
      return fail(GENERIC_FAILURE, 500);
    }
  };

  const create: Handler = async (req) => {
    const body = await intake(req);
    if (body instanceof Response) return body;
    if (busy) return fail("Another project is being added. Wait for it to finish.", 409);
    busy = true;
    const secret = typeof body.linearApiKey === "string" ? body.linearApiKey : "";
    try {
      const result = await createProject(body, getDeps());
      log.info("dashboard.add_project", {
        project: typeof body.name === "string" ? body.name : null,
        ok: result.ok,
        steps: result.steps,
      });
      return Response.json({ ...result, canSwitch: opts.canSwitch === true });
    } catch (err) {
      if (err instanceof InputError) return fail(err.message, 400);
      log.error("dashboard.add_project_failed", { error: redact((err as Error).message, secret) });
      return fail(GENERIC_FAILURE, 500);
    } finally {
      busy = false;
    }
  };

  return {
    "/projects/validate-key": { POST: guard(validateKey) },
    "/projects": { POST: guard(create) },
    "/assets/add-project.js": {
      GET: guard(asset("add-project.js", "text/javascript; charset=utf-8")),
    },
    "/assets/add-project.css": { GET: guard(asset("add-project.css", "text/css; charset=utf-8")) },
  };
}
