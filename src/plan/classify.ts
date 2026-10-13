// Last edited: 2026-10-12 18:02 PDT
// The Haiku complexity classifier. One `claude -p` call with a JSON schema, no tools, no MCP, no
// repo access. Complexity alone picks the planner model; priority is an input, never an override.

import { z } from "zod";
import type { Config } from "../config.ts";
import type { PickableIssue } from "../linear/index.ts";
import { marshallHome } from "../paths.ts";
import { runClaude } from "../runner/claude.ts";
import { priorityWord } from "./brief.ts";
import { type Classification, PlanError } from "./types.ts";

export const ClassificationSchema = z
  .object({
    complexity: z.enum(["trivial", "simple", "complex"]),
    reason: z.string().min(1),
  })
  .strict();

export const CLASSIFIER_TIMEOUT_MS = 60_000;

/**
 * The schema passed to `--json-schema`. zod adds a `$schema` draft URL, and Claude Code's validator
 * (ajv) rejects a draft it has not loaded ("no schema with key or ref ..."), so it is dropped.
 */
export function classifierJsonSchema(): Record<string, unknown> {
  const { $schema: _draft, ...schema } = z.toJSONSchema(ClassificationSchema);
  return schema;
}

const PREAMBLE = `You are a triage classifier for a software team. Read the issue below and decide
how complex the fix is. Answer with JSON only.

"trivial": a one-line or few-line fix in one place, with an obvious cause and no judgment call.
A typo, a copy change, a wrong constant, a missing null check, a wrong condition with a clear
correct value.

"simple": one area of the code, a clear fix, no schema or data migration, no cross-module design
choice, no new user-facing feature, but more than a one-liner or with some room for judgment.

"complex": a new feature, several areas of the code, an open design choice, a migration, a change
to a public interface, or an issue whose description leaves the shape of the fix open.

When unsure between two levels, answer the higher one. Give one sentence of reason.`;

/** The prompt for one issue. Pure, so the tests snapshot it. */
export function classifierPrompt(issue: PickableIssue): string {
  return [
    PREAMBLE,
    "",
    `Title: ${issue.title}`,
    `Priority: ${priorityWord(issue.priority)}`,
    `Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "(none)"}`,
    `Comments: ${issue.comments.length}`,
    "",
    "Description:",
    issue.description?.trim() || "(no description)",
  ].join("\n");
}

/** argv for `claude -p`. Documented in docs/planning.md; the tests assert on it. */
export function classifierArgv(prompt: string, model: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(classifierJsonSchema()),
    "--tools",
    "",
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    prompt,
  ];
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Read the classification out of `--output-format json`. The envelope carries `structured_output`
 * when the schema was honored; older CLIs put the JSON text in `result`. A bare object also passes.
 */
export function parseClassifierOutput(stdout: string): Classification {
  const parsed = tryJson(stdout.trim());
  if (!parsed || typeof parsed !== "object") {
    throw new PlanError("classifier_bad_output", `not JSON: ${stdout.trim().slice(0, 200)}`);
  }
  const env = parsed as Record<string, unknown>;
  if (env.is_error === true) {
    throw new PlanError("classifier_bad_output", `claude reported an error: ${String(env.result)}`);
  }
  const candidates = [
    env.structured_output,
    typeof env.result === "string" ? tryJson(env.result) : env.result,
    env,
  ];
  for (const c of candidates) {
    const r = ClassificationSchema.safeParse(c);
    if (r.success) return r.data;
  }
  throw new PlanError(
    "classifier_bad_output",
    `no classification in: ${stdout.trim().slice(0, 200)}`,
  );
}

export interface ClassifyOpts {
  model?: string;
  timeoutMs?: number;
}

/** Classify one issue. Runs from MARSHALL_HOME so no project settings or MCP servers load. */
export async function classifyIssue(
  issue: PickableIssue,
  opts: ClassifyOpts = {},
): Promise<Classification> {
  const argv = classifierArgv(classifierPrompt(issue), opts.model ?? "haiku");
  let stdout: string;
  try {
    stdout = await runClaude(argv, {
      cwd: marshallHome(),
      timeoutMs: opts.timeoutMs ?? CLASSIFIER_TIMEOUT_MS,
    });
  } catch (err) {
    throw new PlanError("classifier_failed", (err as Error).message);
  }
  return parseClassifierOutput(stdout);
}

/** `trivial` → `models.planTrivial`, `simple` → `models.planSimple`, `complex` → `models.planComplex`. */
export function modelFor(classification: Classification, config: Config): string {
  switch (classification.complexity) {
    case "trivial":
      return config.models.planTrivial;
    case "simple":
      return config.models.planSimple;
    case "complex":
      return config.models.planComplex;
  }
}
