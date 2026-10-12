// Last edited: 2026-10-11 21:00 PDT
// `createProject`: the "add a project" pipeline. Seven steps, run in order, each reported as
// `{ step, ok, detail }`; the first failure stops the run. Every step is safe to run again (a step
// that is already done says "Already done"), so a failed run is fixed by pressing Create again.
// The API key is written to `secrets.env` and sent to Linear, and goes nowhere else: every
// outgoing string passes through `redact`, and no step puts the key in a detail on purpose.

import { join } from "node:path";
import { ConfigError } from "../config.ts";
import { ensureWorkspaceSetup } from "../linear/setup.ts";
import {
  addProject,
  getActive,
  getProject,
  ProjectError,
  parseEnvFile,
  projectDir,
  writeSecret,
} from "../projects.ts";
import { configPathFor, writeProjectConfig } from "./config-file.ts";
import { checkLinearKey, KeyCheckError } from "./key-check.ts";
import { getRepo, RepoError, type RepoOutcome } from "./repo.ts";
import type { CreateProjectResult, SetupDeps, StepResult, TeamInfo } from "./types.ts";
import { repoPathFor, type ValidInput, validateInput } from "./validate.ts";

const SECRET_NAME = "MARSHALL_LINEAR_API_KEY";

/** State the steps share. */
interface Run {
  deps: SetupDeps;
  input: ValidInput;
  repoPath: string;
  workspace: string;
  teams: TeamInfo[];
  team: TeamInfo | null;
  repo: RepoOutcome | null;
}

/** A failure the person can act on, with a message that is safe to show. */
class StepFailure extends Error {
  override name = "StepFailure";
  constructor(
    message: string,
    readonly needsTeam = false,
  ) {
    super(message);
  }
}

export function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

async function stepKey(run: Run): Promise<string> {
  const info = await checkLinearKey(run.deps, run.input.linearApiKey);
  run.workspace = info.workspace;
  run.teams = info.teams;
  const wanted = run.input.teamId;
  const team = wanted
    ? info.teams.find((t) => t.id === wanted)
    : info.teams.length === 1
      ? info.teams[0]
      : undefined;
  if (wanted && !team) throw new StepFailure("That team is not in this Linear workspace.");
  if (!team) {
    throw new StepFailure(
      `Workspace ${info.workspace} has ${info.teams.length} teams. Pick one.`,
      true,
    );
  }
  run.team = team;
  return `Workspace ${info.workspace}, team ${team.name} (${team.key}).`;
}

async function stepName(run: Run): Promise<string> {
  const { slug, name } = run.input;
  const existing = getProject(slug);
  if (!existing) return `"${name}" is a new project (id ${slug}).`;
  let same = false;
  try {
    const cfg = Bun.JSONC.parse(run.deps.fs.readFileSync(existing.configPath, "utf8")) as Record<
      string,
      unknown
    >;
    same = cfg.workspace === run.workspace && cfg.repoPath === run.repoPath;
  } catch {
    same = false;
  }
  if (!same) {
    throw new StepFailure(
      `A project with the id "${slug}" already exists for another workspace or repo. Pick another name.`,
    );
  }
  return `Already done: "${name}" exists with this workspace and repo; finishing it.`;
}

async function stepSecret(run: Run): Promise<string> {
  const path = join(projectDir(run.input.slug), "secrets.env");
  const key = run.input.linearApiKey;
  if (run.deps.fs.existsSync(path)) {
    const current = parseEnvFile(run.deps.fs.readFileSync(path, "utf8"))[SECRET_NAME];
    if (current === key) return "Already done: the key is saved (file mode 0600).";
  }
  writeSecret(path, SECRET_NAME, key);
  return "Saved the key to this project's private file (mode 0600).";
}

async function stepRepo(run: Run): Promise<string> {
  run.repo = await getRepo(run.deps, run.input.repo, run.repoPath);
  return run.repo.detail;
}

async function stepLinear(run: Run): Promise<string> {
  const gql = run.deps.gql(run.input.linearApiKey);
  const result = await ensureWorkspaceSetup(gql, (run.team as TeamInfo).id, run.deps.log);
  const all = [
    result.needsVerification,
    result.blocked,
    result.agentFiled,
    result.humanOnly,
    result.marshallGroup,
    ...result.agents,
  ];
  const created = all.filter((e) => e.created).length;
  return created === 0
    ? "Already done: the Needs Verification and Blocked states and the Marshall labels exist."
    : `Created ${created} of ${all.length} states and labels in Linear.`;
}

async function stepTrust(run: Run): Promise<string> {
  const result = run.deps.trust(run.repoPath);
  if (result === "unreadable") {
    throw new StepFailure(
      "Claude Code's config file could not be read, so it was left alone. Fix it and run again.",
    );
  }
  const text = {
    trusted: "Marked the repo as trusted in Claude Code.",
    already_trusted: "Already done: the repo is trusted in Claude Code.",
    no_config:
      "Claude Code has no config file here yet, so nothing to trust. Run claude once on this machine.",
  } as const;
  return text[result];
}

async function stepConfig(run: Run): Promise<string> {
  const { slug, name } = run.input;
  const repo = run.repo as RepoOutcome;
  const wrote = writeProjectConfig(run.deps, slug, {
    workspace: run.workspace,
    teamId: (run.team as TeamInfo).id,
    repoPath: run.repoPath,
    baseBranch: repo.baseBranch,
  });
  const configState =
    wrote === "written" ? "Wrote the config" : "Already done: the config is current";
  if (getProject(slug)) return `${configState}; the project is registered.`;
  const record = addProject({ slug, name, configPath: configPathFor(slug) }, run.deps.now());
  const active = getActive();
  const where =
    active?.slug === record.slug
      ? "It is the active project."
      : `${active?.name ?? "Another project"} stays active.`;
  return `${configState} and registered the project. ${where}`;
}

const STEPS: Array<[string, (run: Run) => Promise<string>]> = [
  ["Check the Linear key", stepKey],
  ["Check the project name", stepName],
  ["Save the key", stepSecret],
  ["Get the repo", stepRepo],
  ["Set up Linear", stepLinear],
  ["Trust the repo", stepTrust],
  ["Write the config", stepConfig],
];

/** What the person sees for a step that threw: our own messages as they are, others generic. */
function isExpected(err: unknown): err is Error {
  return (
    err instanceof StepFailure ||
    err instanceof KeyCheckError ||
    err instanceof RepoError ||
    err instanceof ProjectError ||
    err instanceof ConfigError
  );
}

function failureDetail(err: unknown): string {
  return isExpected(err)
    ? err.message
    : "Something unexpected went wrong. Check the dashboard log.";
}

export async function createProject(raw: unknown, deps: SetupDeps): Promise<CreateProjectResult> {
  const input = validateInput(raw);
  const run: Run = {
    deps,
    input,
    repoPath: repoPathFor(deps.codeDir, input.repo.name),
    workspace: "",
    teams: [],
    team: null,
    repo: null,
  };
  const steps: StepResult[] = [];
  const result: CreateProjectResult = { ok: true, steps, slug: input.slug };
  for (const [step, fn] of STEPS) {
    try {
      const detail = await fn(run);
      steps.push({ step, ok: true, detail: redact(detail, input.linearApiKey) });
    } catch (err) {
      const detail = redact(failureDetail(err), input.linearApiKey);
      if (!isExpected(err)) {
        deps.log.error("project_setup.step_failed", {
          project: input.name,
          step,
          error: redact((err as Error).message ?? String(err), input.linearApiKey),
        });
      }
      steps.push({ step, ok: false, detail });
      result.ok = false;
      if (err instanceof StepFailure && err.needsTeam) {
        result.needsTeam = true;
        result.teams = run.teams;
      }
      break;
    }
  }
  if (run.workspace) result.workspace = run.workspace;
  if (result.ok) result.active = getActive()?.slug === input.slug;
  return result;
}
