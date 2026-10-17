import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentSnapshotPayload,
  AgentTurnContinuationReceiptPayload,
} from "@getpaseo/protocol/messages";
import { AGENT_TURN_CONTINUATION_PROMPT_MAX_LENGTH } from "@getpaseo/protocol/messages";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

export interface AgentContinueAfterFailureOptions extends CommandOptions {
  expectTurn?: string;
  expectConfigDigest?: string;
  idempotencyKey?: string;
  prompt?: string;
  promptFile?: string;
}

export interface AgentContinueAfterFailureResult {
  agentId: string;
  status: "started" | "outcome_unknown" | "refused";
  refusalReason: string | null;
  receipt: AgentTurnContinuationReceiptPayload | null;
}

const continueAfterFailureSchema: OutputSchema<AgentContinueAfterFailureResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 18 },
    { header: "REFUSAL", field: (result) => result.refusalReason ?? "-", width: 30 },
    { header: "NEW TURN", field: (result) => result.receipt?.newTurnId ?? "unknown", width: 20 },
  ],
  serialize: (result) => result,
};

export function addContinueAfterFailureOptions(cmd: Command): Command {
  return cmd
    .description("Continue the same agent after a failed turn when exact safety checks pass")
    .argument("<id>", "Agent ID, prefix, or name")
    .requiredOption("--expect-turn <turn-id>", "The failed last turn returned by observe-turn")
    .requiredOption(
      "--expect-config-digest <digest>",
      "The lowercase SHA-256 hex config digest returned by observe-turn",
    )
    .requiredOption("--idempotency-key <key>", "Stable caller key for this one continuation")
    .option("--prompt <text>", "The continuation prompt, passed verbatim")
    .option("--prompt-file <path>", "Read the continuation prompt verbatim as UTF-8");
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

async function readContinuationPrompt(options: AgentContinueAfterFailureOptions): Promise<string> {
  const hasInline = options.prompt !== undefined;
  const hasFile = options.promptFile !== undefined;
  if (hasInline === hasFile) {
    throw {
      code: "INVALID_PROMPT_INPUT",
      message: "Provide exactly one of --prompt or --prompt-file",
    } satisfies CommandError;
  }
  let prompt: string;
  if (hasInline) {
    prompt = options.prompt as string;
  } else {
    try {
      prompt = await readFile(resolve(options.promptFile as string), "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) throw error;
      throw {
        code: "PROMPT_FILE_READ_ERROR",
        message: `Failed to read prompt file: ${options.promptFile}`,
        details: error instanceof Error ? error.message : String(error),
      } satisfies CommandError;
    }
  }
  if (!prompt.trim() || prompt.length > AGENT_TURN_CONTINUATION_PROMPT_MAX_LENGTH) {
    throw {
      code: "INVALID_PROMPT",
      message: `Prompt must contain non-whitespace text and be at most ${AGENT_TURN_CONTINUATION_PROMPT_MAX_LENGTH} characters`,
    } satisfies CommandError;
  }
  return prompt;
}

export async function runContinueAfterFailureCommand(
  agentIdArg: string,
  options: AgentContinueAfterFailureOptions,
  _command: Command,
): Promise<SingleResult<AgentContinueAfterFailureResult>> {
  if (!agentIdArg.trim()) {
    throw {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
    } satisfies CommandError;
  }
  const prompt = await readContinuationPrompt(options);
  if (!options.expectTurn || !options.expectConfigDigest || !options.idempotencyKey?.trim()) {
    throw {
      code: "MISSING_CONTINUATION_ARGUMENT",
      message: "Turn ID, config digest, and idempotency key are required",
    } satisfies CommandError;
  }

  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const agents = await client.fetchAgents({ filter: { includeArchived: true } });
    const agentId = resolveFullAgentId(
      agentIdArg,
      agents.entries.map((entry) => entry.agent),
    );
    const result = await client.continueAfterFailure({
      agentId,
      expectedTurnId: options.expectTurn,
      expectedConfigDigest: options.expectConfigDigest,
      idempotencyKey: options.idempotencyKey,
      prompt,
    });
    return {
      type: "single",
      data: { agentId, ...result },
      schema: continueAfterFailureSchema,
    };
  } finally {
    await client.close();
  }
}
