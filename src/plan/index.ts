// Last edited: 2026-10-18 14:30 PDT
// Public API of the planning phase. Step 08 imports from here and nowhere else in src/plan.

export { briefPath, priorityWord, renderBrief, writeBrief } from "./brief.ts";
export {
  ClassificationSchema,
  classifierArgv,
  classifierPrompt,
  classifyIssue,
  modelFor,
  parseClassifierOutput,
} from "./classify.ts";
export {
  checkIntakePlan,
  INTAKE_SECTIONS,
  type IntakeCheck,
  type IntakeInput,
  type IntakeResult,
  intakePlanPath,
  parseReposTouched,
  planSourceOf,
  type RepoRef,
  type RepoRole,
  runPlanIntake,
} from "./intake.ts";
export { PLUGIN_DIR, runPlanPhase } from "./phase.ts";
export { renderSummary } from "./summary.ts";
export {
  checkPlanFile,
  checkPlanText,
  isPlanPath,
  type PlanCheck,
  REQUIRED_SECTIONS,
  TEMPLATE_PATH,
} from "./template.ts";
export type {
  Classification,
  Complexity,
  PlanFailure,
  PlanMode,
  PlanPhaseInput,
  PlanPhaseResult,
  RunWaiter,
} from "./types.ts";
export { PlanError } from "./types.ts";
export { planFilesOnBranch, type VerifyResult, verifyPlanCommit } from "./verify.ts";
export { createRunWaiter, terminalOf } from "./wait.ts";
