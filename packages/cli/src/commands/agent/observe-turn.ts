import type { Command } from "commander";
import type {
  AgentTurnObservationPayload,
  AgentSnapshotPayload,
} from "@getpaseo/protocol/messages";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface AgentTurnObserveResult extends AgentTurnObservationPayload {
  agentId: string;
}

export interface AgentTurnObserveOptions extends CommandOptions {
  turn?: string;
}

const agentTurnObserveSchema: OutputSchema<AgentTurnObserveResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "TURN ID", field: (result) => result.turnId ?? "unknown", width: 20 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "PROVIDER", field: (result) => result.provider ?? "unknown", width: 12 },
    { header: "EFFECTS", field: (result) => result.effects.state, width: 16 },
    { header: "COMPLETE", field: (result) => String(result.complete), width: 10 },
  ],
  serialize: (result) => result,
};

export function addObserveTurnOptions(cmd: Command): Command {
  return cmd
    .description("Read the exact last agent turn or a requested turn")
    .argument("<id>", "Agent ID, prefix, or name")
    .option("--turn <turn-id>", "Observe this exact turn instead of the last turn");
}

function resolveFullAgentId(id: string, agents: AgentSnapshotPayload[]): string {
  const resolved = resolveAgentId(id, agents);
  if (!resolved) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${id}`,
      details: 'Use "paseo agent ls" to list available agents',
    } satisfies CommandError;
  }
  return resolved;
}

export async function runObserveTurnCommand(
  agentIdArg: string,
  options: AgentTurnObserveOptions,
  _command: Command,
): Promise<SingleResult<AgentTurnObserveResult>> {
  if (!agentIdArg.trim()) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
    } satisfies CommandError;
  }
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const agents = await client.fetchAgents({ filter: { includeArchived: true } });
    const agentId = resolveFullAgentId(
      agentIdArg,
      agents.entries.map((entry) => entry.agent),
    );
    const observation = await client.observeAgentTurn(agentId, { turnId: options.turn });
    return {
      type: "single",
      data: { agentId, ...observation },
      schema: agentTurnObserveSchema,
    };
  } finally {
    await client.close();
  }
}
