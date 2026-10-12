// Last edited: 2026-10-11 21:00 PDT
// Step 1: ask Linear who this key belongs to. Returns the workspace slug and its teams. Reads
// only; nothing is stored. Reuses the shared GraphQL transport and `run` helper.

import { z } from "zod";
import { run } from "../linear/client.ts";
import { LinearError } from "../linear/gql.ts";
import type { Operation } from "../linear/queries.ts";
import type { SetupDeps, TeamInfo } from "./types.ts";

interface KeyCheckData {
  viewer: { organization: { urlKey: string } };
  teams: { nodes: TeamInfo[] };
}

export const KeyCheck: Operation<KeyCheckData> = {
  name: "KeyCheck",
  doc: "query KeyCheck { viewer { organization { urlKey } } teams { nodes { id key name } } }",
  schema: z.object({
    viewer: z.object({ organization: z.object({ urlKey: z.string() }) }),
    teams: z.object({
      nodes: z.array(z.object({ id: z.string(), key: z.string(), name: z.string() })),
    }),
  }),
};

export class KeyCheckError extends Error {
  override name = "KeyCheckError";
}

export interface KeyInfo {
  workspace: string;
  teams: TeamInfo[];
}

export async function checkLinearKey(deps: SetupDeps, apiKey: string): Promise<KeyInfo> {
  let data: KeyCheckData;
  try {
    data = await run(deps.gql(apiKey), KeyCheck);
  } catch (err) {
    if (
      err instanceof LinearError &&
      (err.status === 401 || err.status === 400 || err.errors?.length)
    ) {
      throw new KeyCheckError("Linear did not accept that key. Check that you copied all of it.");
    }
    throw new KeyCheckError("Could not reach Linear to check the key. Try again in a moment.");
  }
  if (data.teams.nodes.length === 0) {
    throw new KeyCheckError("This Linear workspace has no teams. Create one in Linear first.");
  }
  return { workspace: data.viewer.organization.urlKey, teams: data.teams.nodes };
}
