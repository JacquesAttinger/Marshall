// Last edited: 2026-10-18 15:30 PDT
// The opt-in pick-up query and `createQueuedPlan`: what the client sends when `pickup` is labeled,
// and the issue it files for `marshall enqueue`.

import { describe, expect, test } from "bun:test";
import { connectLinear } from "../../src/linear/client.ts";
import { recordingLogger } from "../helpers.ts";
import { fakeLinear, fullTeamData, type Handler, IDS } from "./fake-linear.ts";

async function connect(
  handlers: Record<string, Handler> = {},
  pickup?: Parameters<typeof connectLinear>[0]["pickup"],
) {
  const fake = fakeLinear(handlers);
  const { log } = recordingLogger();
  const client = await connectLinear({
    apiKey: "lin_test",
    teamId: IDS.team,
    workspace: "chessbuddy",
    log,
    fetchImpl: fake.fetchImpl,
    pickup,
  });
  return { fake, client };
}

describe("listPickable: opt-in pick-up", () => {
  test("labeled mode refuses a team that lacks the opt-in label and points at setup", async () => {
    const team = fullTeamData();
    team.team.labels.nodes = team.team.labels.nodes.filter((l) => l.name !== "marshall:queued");
    const fake = fakeLinear({ TeamMeta: () => team });
    const { log } = recordingLogger();
    const attempt = connectLinear({
      apiKey: "lin_test",
      teamId: IDS.team,
      workspace: "chessbuddy",
      log,
      fetchImpl: fake.fetchImpl,
      pickup: { mode: "labeled", label: "marshall:queued" },
    });
    await expect(attempt).rejects.toThrow(/label "marshall:queued".*marshall linear setup/);
  });

  test("builds the labeled query with the label and project variables", async () => {
    const { fake, client } = await connect(
      {},
      { mode: "labeled", label: "marshall:queued", projectId: "proj-1" },
    );
    await client.listPickable();
    const call = fake.callsFor("PickableIssues")[0];
    expect(call?.variables).toEqual({
      teamId: IDS.team,
      assigneeId: IDS.viewer,
      label: "marshall:queued",
      projectId: "proj-1",
    });
    expect(call?.query).toContain("$label: String!");
    expect(call?.query).toContain("labels: { some: { name: { eq: $label } } }");
    expect(call?.query).toContain('labels: { every: { name: { neq: "human-only" } } }');
    expect(call?.query).toContain("project: { id: { eq: $projectId } }");
  });
});

describe("createQueuedPlan", () => {
  test("files a Todo issue for me with the plan body and both opt-in labels", async () => {
    const { fake, client } = await connect();
    const created = await client.createQueuedPlan({ title: "Add a thing", description: "# Plan" });
    expect(created).toEqual({
      id: "issue-plan",
      identifier: "CB-100",
      url: "https://linear.app/chessbuddy/issue/CB-100",
      branchName: "me/cb-100-add-a-thing",
    });
    const create = fake.callsFor("CreatePlanIssue")[0]?.variables as {
      input: Record<string, unknown>;
    };
    expect(create.input).toEqual({
      teamId: IDS.team,
      title: "Add a thing",
      description: "# Plan",
      assigneeId: IDS.viewer,
      stateId: IDS.todo,
      labelIds: [IDS.queued, IDS.hasPlan],
    });
  });

  test("refuses, naming setup, when the team lacks the labels", async () => {
    const team = fullTeamData();
    team.team.labels.nodes = team.team.labels.nodes.filter((l) => !l.name.startsWith("marshall:"));
    const { client } = await connect({ TeamMeta: () => team });
    await expect(client.createQueuedPlan({ title: "t", description: "d" })).rejects.toThrow(
      /marshall linear setup/,
    );
  });
});
