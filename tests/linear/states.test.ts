// Last edited: 2026-10-18 15:59 PDT
// Configurable status names: a team that cannot add statuses names the ones it has. The client must
// check and use those names, the merge sweep must stay narrow, and setup must create labels only.

import { describe, expect, test } from "bun:test";
import { connectLinear } from "../../src/linear/client.ts";
import { createGql } from "../../src/linear/gql.ts";
import type { TeamMeta } from "../../src/linear/queries.ts";
import { ensureWorkspaceSetup } from "../../src/linear/setup.ts";
import { recordingLogger } from "../helpers.ts";
import { fakeLinear, fullTeamData, type Handler, IDS } from "./fake-linear.ts";

/** Hemut's shape: Marshall's two statuses are absent, and "In Review" and "Backlog" exist. */
function hemutTeam(): { team: TeamMeta } {
  const data = fullTeamData();
  data.team.states.nodes = [
    { id: IDS.todo, name: "Todo", type: "unstarted", position: 1 },
    { id: IDS.inProgress, name: "In Progress", type: "started", position: 2 },
    { id: "state-in-review", name: "In Review", type: "started", position: 2.5 },
    { id: IDS.done, name: "Done", type: "completed", position: 3 },
    { id: "state-backlog", name: "Backlog", type: "backlog", position: 0 },
  ];
  return data;
}

const HEMUT_STATES = { needsVerification: "In Review", blocked: "Backlog" };

async function connect(
  handlers: Record<string, Handler>,
  options: Partial<Parameters<typeof connectLinear>[0]> = {},
) {
  const fake = fakeLinear(handlers);
  const { log } = recordingLogger();
  const client = await connectLinear({
    apiKey: "lin_test",
    teamId: IDS.team,
    workspace: "chessbuddy",
    log,
    fetchImpl: fake.fetchImpl,
    ...options,
  });
  return { fake, client };
}

describe("connectLinear with custom status names", () => {
  test("the client exposes the defaults when none are given", async () => {
    const { client } = await connect({});
    expect(client.states).toEqual({ needsVerification: "Needs Verification", blocked: "Blocked" });
  });

  test("accepts a team that has the named statuses and none of the default ones", async () => {
    const { client, fake } = await connect({ TeamMeta: hemutTeam }, { states: HEMUT_STATES });
    expect(client.states).toEqual(HEMUT_STATES);
    await client.setState("issue-1", client.states.needsVerification);
    expect(fake.callsFor("UpdateIssue")[0]?.variables).toEqual({
      id: "issue-1",
      input: { stateId: "state-in-review" },
    });
  });

  test("refuses, naming the missing status and pointing at setup", async () => {
    const attempt = connect(
      { TeamMeta: hemutTeam },
      { states: { needsVerification: "Needs Verification", blocked: "Backlog" } },
    );
    await expect(attempt).rejects.toThrow(/state "Needs Verification".*marshall linear setup/);
  });
});

describe("listAwaitingMerge with custom names", () => {
  const reviewable: Record<string, Handler> = {
    TeamMeta: () => {
      const data = hemutTeam();
      data.team.labels.nodes.push({
        id: IDS.queued,
        name: "marshall:queued",
        isGroup: false,
        parent: null,
      });
      return data;
    },
    ReviewableIssues: () => ({ issues: { nodes: [] } }),
  };

  test("sends the configured names as the states variable", async () => {
    const { client, fake } = await connect(reviewable, { states: HEMUT_STATES });
    await client.listAwaitingMerge();
    expect(fake.callsFor("ReviewableIssues")[0]?.variables).toEqual({
      teamId: IDS.team,
      assigneeId: IDS.viewer,
      states: ["In Review", "Backlog"],
    });
  });

  test("in labeled mode it also requires the opt-in label, so busy statuses are not swept", async () => {
    const { client, fake } = await connect(reviewable, {
      states: HEMUT_STATES,
      pickup: { mode: "labeled", label: "marshall:queued" },
    });
    await client.listAwaitingMerge();
    const call = fake.callsFor("ReviewableIssues")[0];
    expect(call?.variables).toMatchObject({ label: "marshall:queued" });
    expect(call?.query).toContain("$label: String!");
    expect(call?.query).toContain("labels: { some: { name: { eq: $label } } }");
  });

  test("in assigned mode there is no label filter", async () => {
    const { client, fake } = await connect(reviewable, { states: HEMUT_STATES });
    await client.listAwaitingMerge();
    expect(fake.callsFor("ReviewableIssues")[0]?.query).not.toContain("labels:");
  });
});

describe("ensureWorkspaceSetup with custom names", () => {
  async function run(names?: { needsVerification: string; blocked: string }) {
    const team = hemutTeam().team;
    team.labels.nodes = [];
    const fake = fakeLinear({ TeamMeta: () => ({ team }) });
    const { log } = recordingLogger();
    const gql = createGql({ apiKey: "k", log, fetchImpl: fake.fetchImpl });
    const result = await ensureWorkspaceSetup(gql, IDS.team, log, names);
    const ops = fake.calls
      .filter((c) => c.operationName !== "TeamMeta")
      .map((c) => c.operationName);
    return { result, ops };
  }

  test("reuses the named statuses and creates only labels", async () => {
    const { result, ops } = await run(HEMUT_STATES);
    expect(ops).not.toContain("CreateState");
    expect(ops.filter((o) => o === "CreateLabel")).toHaveLength(8);
    expect(result.needsVerification).toEqual({
      id: "state-in-review",
      name: "In Review",
      created: false,
    });
    expect(result.blocked).toEqual({ id: "state-backlog", name: "Backlog", created: false });
  });

  test("with the default names on this team it still tries to create the two statuses", async () => {
    const { ops } = await run();
    expect(ops.filter((o) => o === "CreateState")).toHaveLength(2);
  });
});
