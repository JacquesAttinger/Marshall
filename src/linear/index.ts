// Last edited: 2026-10-18 14:20 PDT
// Public surface of the Linear module. Steps 06, 07, and 08 import from here.

export {
  type ConnectOptions,
  type CreatedIssue,
  type CreatedPlanIssue,
  connectLinear,
  type FollowUpInput,
  type LinearClient,
  type PlanIssueInput,
  run,
  type ViewerInfo,
  verifyWorkspace,
} from "./client.ts";
export {
  createGql,
  type Gql,
  LinearError,
  LinearRateLimitError,
  type RateBudget,
} from "./gql.ts";
export {
  AGENT_FILED_LABEL,
  AGENT_IDS,
  type AgentId,
  agentLabelName,
  BLOCKED_STATE,
  HAS_PLAN_LABEL,
  HUMAN_ONLY_LABEL,
  IN_PROGRESS_STATE,
  type IssueComment,
  type IssueDetail,
  isAgentId,
  isFromMarshall,
  isHasPlan,
  isHumanOnly,
  MARSHALL_COMMENT_FOOTER,
  MARSHALL_LABEL_GROUP,
  NEEDS_VERIFICATION_STATE,
  type PickableIssue,
  QUEUED_LABEL,
  TODO_STATE,
} from "./map.ts";
export { type Ensured, ensureWorkspaceSetup, type SetupResult } from "./setup.ts";
