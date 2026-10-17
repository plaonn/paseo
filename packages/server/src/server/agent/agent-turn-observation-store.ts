import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTurnContinuationRefusalReason } from "@getpaseo/protocol/messages";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const TurnStatusSchema = z.enum(["running", "completed", "failed", "cancelled", "unknown"]);
const ToolCallEffectSchema = z.object({
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
const FileWriteEffectSchema = z.object({
  callId: z.string(),
  path: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
const ShellCommandEffectSchema = z.object({
  callId: z.string(),
  command: z.string().nullable(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
const MessageDeliveryEffectSchema = z.object({
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
const SubAgentSpawnEffectSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
});
const EffectManifestSchema = z.object({
  toolCalls: z.array(ToolCallEffectSchema),
  fileWrites: z.array(FileWriteEffectSchema),
  shellCommands: z.array(ShellCommandEffectSchema),
  messageDeliveries: z.array(MessageDeliveryEffectSchema),
  subAgentSpawns: z.array(SubAgentSpawnEffectSchema),
  assistantResponses: z.number().int().nonnegative(),
});
const EffectsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none_proven") }),
  z.object({ state: z.literal("present") }).extend(EffectManifestSchema.shape),
  z
    .object({ state: z.literal("unknown"), reason: z.string() })
    .extend({ observed: EffectManifestSchema }),
]);

const ProviderErrorSchema = z.object({
  providerCode: z.union([z.string(), z.number()]).nullable(),
  providerClass: z.string().nullable(),
  rawMessage: z.string(),
  normalizedClass: z.enum(["capacity_overload", "unknown"]),
});

const TurnObservationSchema = z.object({
  order: z.number().int().nonnegative(),
  agentId: z.string(),
  turnId: z.string(),
  status: TurnStatusSchema,
  provider: z.string(),
  workspaceId: z.string().nullable(),
  model: z.string().nullable(),
  thinkingEffort: z.string().nullable(),
  mode: z.string().nullable(),
  configDigest: z.string(),
  configComplete: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  error: ProviderErrorSchema.nullable(),
  effects: EffectsSchema,
  complete: z.boolean(),
  truncated: z.boolean(),
  telemetryFailed: z.boolean(),
});

const JournalSchema = z.object({
  version: z.literal(1),
  nextOrder: z.number().int().nonnegative(),
  turns: z.array(TurnObservationSchema),
});

const ReceiptSchema = z.object({
  key: z.string(),
  agentId: z.string(),
  turnId: z.string(),
  newTurnId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  configDigest: z.string(),
  state: z.enum(["pending", "outcome_unknown", "started"]),
});

export type AgentTurnObservation = z.infer<typeof TurnObservationSchema>;
export type AgentTurnEffects = z.infer<typeof EffectsSchema>;
export type AgentTurnEffectManifest = z.infer<typeof EffectManifestSchema>;
export type AgentTurnProviderError = z.infer<typeof ProviderErrorSchema>;
export type AgentTurnContinuationReceipt = z.infer<typeof ReceiptSchema>;

export interface AgentTurnConfigSnapshot {
  model: string | null;
  thinkingEffort: string | null;
  mode: string | null;
}

export interface AgentTurnStartInput {
  agentId: string;
  turnId: string;
  workspaceId: string | null;
  provider: string;
  config: AgentTurnConfigSnapshot;
  startedAt?: string;
}

export interface AgentTurnFinishInput {
  agentId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
  providerCode: string | number | null;
  providerClass: string | null;
  rawMessage: string | null;
  telemetryIncomplete?: boolean;
  finishedAt?: string;
}

export type AgentTurnContinuationPreparation =
  | { status: "refused"; reason: AgentTurnContinuationRefusalReason }
  | {
      status: "prepared";
      agentId: string;
      turnId: string;
      configDigest: string;
      start: () => Promise<string>;
      release: () => void;
    };

export type AgentTurnContinuationResult =
  | { status: "refused"; reason: AgentTurnContinuationRefusalReason }
  | {
      status: "receipt";
      receipt: AgentTurnContinuationReceipt;
      replayed: boolean;
    };

export function digestAgentTurnConfig(input: {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  model: string | null;
  thinkingEffort: string | null;
  mode: string | null;
}): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => {
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      return Object.fromEntries(
        Object.entries(candidate).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return candidate;
  });
}

function emptyManifest(): AgentTurnEffectManifest {
  return {
    toolCalls: [],
    fileWrites: [],
    shellCommands: [],
    messageDeliveries: [],
    subAgentSpawns: [],
    assistantResponses: 0,
  };
}

function filenameFor(value: string): string {
  return `${createHash("sha256").update(value).digest("hex")}.json`;
}

async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return schema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function upsertById<T extends { callId: string }>(items: T[], item: T): void {
  const existing = items.findIndex((candidate) => candidate.callId === item.callId);
  if (existing === -1) items.push(item);
  else items[existing] = item;
}

function manifestFromEffects(effects: AgentTurnEffects): AgentTurnEffectManifest {
  if (effects.state === "present") {
    return {
      toolCalls: effects.toolCalls,
      fileWrites: effects.fileWrites,
      shellCommands: effects.shellCommands,
      messageDeliveries: effects.messageDeliveries,
      subAgentSpawns: effects.subAgentSpawns,
      assistantResponses: effects.assistantResponses,
    };
  }
  if (effects.state === "unknown") return effects.observed;
  return emptyManifest();
}

function hasEffects(manifest: AgentTurnEffectManifest): boolean {
  return (
    manifest.toolCalls.length > 0 ||
    manifest.fileWrites.length > 0 ||
    manifest.shellCommands.length > 0 ||
    manifest.messageDeliveries.length > 0 ||
    manifest.subAgentSpawns.length > 0 ||
    manifest.assistantResponses > 0
  );
}

function observeEffects(
  observation: AgentTurnObservation,
  manifest: AgentTurnEffectManifest,
): AgentTurnEffects {
  if (observation.provider !== "codex" || observation.truncated) {
    return {
      state: "unknown",
      reason: observation.truncated ? "timeline_truncated" : "provider_unverified",
      observed: manifest,
    };
  }
  if (hasEffects(manifest)) return { state: "present", ...manifest };
  if (observation.status === "running") {
    return { state: "unknown", reason: "turn_in_progress", observed: manifest };
  }
  return { state: "none_proven" };
}

function finishedEffects(
  observation: AgentTurnObservation,
  manifest: AgentTurnEffectManifest,
): AgentTurnEffects {
  if (observation.complete) {
    return hasEffects(manifest) ? { state: "present", ...manifest } : { state: "none_proven" };
  }
  let reason = "provider_unverified";
  if (observation.truncated) reason = "timeline_truncated";
  else if (observation.telemetryFailed) reason = "telemetry_write_failed";
  return { state: "unknown", reason, observed: manifest };
}

function providerError(input: AgentTurnFinishInput): AgentTurnProviderError | null {
  if (input.status !== "failed") return null;
  const normalizedClass =
    input.providerCode === "server_overloaded" || input.providerClass === "server_overloaded"
      ? "capacity_overload"
      : "unknown";
  return {
    providerCode: input.providerCode,
    providerClass: input.providerClass,
    rawMessage: input.rawMessage ?? "",
    normalizedClass,
  };
}

function isTruncatedItem(item: AgentTimelineItem): boolean {
  if (item.type !== "tool_call") return false;
  if (item.detail.type === "search") return item.detail.truncated === true;
  if (item.detail.type === "worktree_setup") return item.detail.truncated === true;
  return false;
}

function applyTimelineItem(observation: AgentTurnObservation, item: AgentTimelineItem): void {
  const manifest = manifestFromEffects(observation.effects);
  if (item.type === "assistant_message") manifest.assistantResponses += 1;
  if (item.type === "tool_call") {
    upsertById(manifest.toolCalls, { callId: item.callId, name: item.name, status: item.status });
    if (item.detail.type === "write" || item.detail.type === "edit") {
      const filePath = item.detail.filePath;
      upsertById(manifest.fileWrites, {
        callId: item.callId,
        path: typeof filePath === "string" ? filePath : null,
        status: item.status,
      });
    }
    if (item.detail.type === "shell") {
      upsertById(manifest.shellCommands, {
        callId: item.callId,
        command: typeof item.detail.command === "string" ? item.detail.command : null,
        status: item.status,
      });
    }
    if (item.detail.type === "sub_agent") {
      const subAgentId = item.detail.childSessionId ?? item.callId;
      const previous = manifest.subAgentSpawns.findIndex((entry) => entry.id === subAgentId);
      const entry = { id: subAgentId, status: item.status } as const;
      if (previous === -1) manifest.subAgentSpawns.push(entry);
      else manifest.subAgentSpawns[previous] = entry;
    }
    if (item.detail.type === "unknown" || item.detail.type === "plain_text") {
      upsertById(manifest.messageDeliveries, {
        callId: item.callId,
        name: item.name,
        status: item.status,
      });
    }
  }
  if (isTruncatedItem(item)) {
    observation.truncated = true;
    observation.complete = false;
  }
  observation.effects = observeEffects(observation, manifest);
}

export class AgentTurnObservationStore {
  private readonly agentTails = new Map<string, Promise<unknown>>();
  private readonly receiptTails = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async startTurn(input: AgentTurnStartInput): Promise<void> {
    await this.withAgentLock(input.agentId, async () => {
      const journal = await this.readJournal(input.agentId);
      const existing = journal.turns.find((turn) => turn.turnId === input.turnId);
      if (existing) return;
      const startedAt = input.startedAt ?? new Date().toISOString();
      const config = {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        model: input.config.model,
        thinkingEffort: input.config.thinkingEffort,
        mode: input.config.mode,
      };
      const observation: AgentTurnObservation = {
        order: journal.nextOrder,
        agentId: input.agentId,
        turnId: input.turnId,
        status: "running",
        provider: input.provider,
        workspaceId: input.workspaceId,
        model: input.config.model,
        thinkingEffort: input.config.thinkingEffort,
        mode: input.config.mode,
        configDigest: digestAgentTurnConfig(config),
        configComplete:
          input.provider.length > 0 &&
          input.config.model !== null &&
          input.config.thinkingEffort !== null &&
          input.config.mode !== null,
        startedAt,
        finishedAt: null,
        error: null,
        effects: {
          state: "unknown",
          reason: "turn_in_progress",
          observed: emptyManifest(),
        },
        complete: false,
        truncated: false,
        telemetryFailed: false,
      };
      journal.nextOrder += 1;
      journal.turns.push(observation);
      await this.writeJournal(input.agentId, journal);
    });
  }

  async recordTimelineItem(
    agentId: string,
    turnId: string,
    item: AgentTimelineItem,
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = journal.turns.find((turn) => turn.turnId === turnId);
      if (!observation) return;
      applyTimelineItem(observation, item);
      if (observation.telemetryFailed) {
        observation.complete = false;
        observation.effects = {
          state: "unknown",
          reason: "telemetry_write_failed",
          observed: manifestFromEffects(observation.effects),
        };
      }
      await this.writeJournal(agentId, journal);
    });
  }

  async markTelemetryIncomplete(agentId: string, turnId: string): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = journal.turns.find((turn) => turn.turnId === turnId);
      if (!observation) return;
      observation.telemetryFailed = true;
      observation.complete = false;
      observation.effects = {
        state: "unknown",
        reason: "telemetry_write_failed",
        observed: manifestFromEffects(observation.effects),
      };
      await this.writeJournal(agentId, journal);
    });
  }

  async recordSubAgentSpawn(
    agentId: string,
    turnId: string,
    subAgentId: string,
    status: "running" | "completed" | "failed" | "canceled" = "running",
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = journal.turns.find((turn) => turn.turnId === turnId);
      if (!observation) return;
      const manifest = manifestFromEffects(observation.effects);
      const existingIndex = manifest.subAgentSpawns.findIndex((entry) => entry.id === subAgentId);
      if (existingIndex === -1) manifest.subAgentSpawns.push({ id: subAgentId, status });
      else manifest.subAgentSpawns[existingIndex] = { id: subAgentId, status };
      observation.effects =
        observation.provider === "codex" && !observation.telemetryFailed
          ? { state: "present", ...manifest }
          : {
              state: "unknown",
              reason: observation.telemetryFailed
                ? "telemetry_write_failed"
                : "provider_unverified",
              observed: manifest,
            };
      await this.writeJournal(agentId, journal);
    });
  }

  async updateSubAgentStatus(
    agentId: string,
    subAgentId: string,
    status: "running" | "completed" | "failed" | "canceled",
  ): Promise<boolean> {
    return this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      let changed = false;
      for (const observation of journal.turns) {
        const manifest = manifestFromEffects(observation.effects);
        const subAgent = manifest.subAgentSpawns.find((entry) => entry.id === subAgentId);
        if (!subAgent || subAgent.status === status) continue;
        subAgent.status = status;
        observation.effects =
          observation.provider === "codex" && !observation.telemetryFailed
            ? { state: "present", ...manifest }
            : {
                state: "unknown",
                reason: observation.telemetryFailed
                  ? "telemetry_write_failed"
                  : "provider_unverified",
                observed: manifest,
              };
        changed = true;
      }
      if (changed) await this.writeJournal(agentId, journal);
      return changed;
    });
  }

  async recordMessageDelivery(
    agentId: string,
    turnId: string,
    delivery: {
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
    },
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = journal.turns.find((turn) => turn.turnId === turnId);
      if (!observation) return;
      const manifest = manifestFromEffects(observation.effects);
      upsertById(manifest.messageDeliveries, delivery);
      observation.effects =
        observation.provider === "codex" && !observation.telemetryFailed
          ? { state: "present", ...manifest }
          : {
              state: "unknown",
              reason: observation.telemetryFailed
                ? "telemetry_write_failed"
                : "provider_unverified",
              observed: manifest,
            };
      await this.writeJournal(agentId, journal);
    });
  }

  async finishTurn(input: AgentTurnFinishInput): Promise<void> {
    await this.withAgentLock(input.agentId, async () => {
      const journal = await this.readJournal(input.agentId);
      const observation = journal.turns.find((turn) => turn.turnId === input.turnId);
      if (!observation) return;
      observation.telemetryFailed =
        observation.telemetryFailed || input.telemetryIncomplete === true;
      observation.status = input.status;
      observation.finishedAt = input.finishedAt ?? new Date().toISOString();
      observation.error = providerError(input);
      observation.complete =
        observation.provider === "codex" && !observation.truncated && !observation.telemetryFailed;
      const manifest = manifestFromEffects(observation.effects);
      observation.effects = finishedEffects(observation, manifest);
      await this.writeJournal(input.agentId, journal);
    });
  }

  async observeTurn(agentId: string, turnId?: string): Promise<AgentTurnObservation | null> {
    return this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = turnId
        ? journal.turns.find((turn) => turn.turnId === turnId)
        : journal.turns.at(-1);
      return observation ? structuredClone(observation) : null;
    });
  }

  async observeExpectedAndLastTurn(
    agentId: string,
    turnId: string,
  ): Promise<{ expected: AgentTurnObservation | null; last: AgentTurnObservation | null }> {
    return this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const expected = journal.turns.find((turn) => turn.turnId === turnId) ?? null;
      const last = journal.turns.at(-1) ?? null;
      return {
        expected: expected ? structuredClone(expected) : null,
        last: last ? structuredClone(last) : null,
      };
    });
  }

  async runContinuation(
    input: { key: string; parameters: unknown },
    prepare: () => Promise<AgentTurnContinuationPreparation>,
  ): Promise<AgentTurnContinuationResult> {
    if (!input.key.trim() || input.key.length > 200) {
      return { status: "refused", reason: "invalid_idempotency_key" };
    }
    return this.withReceiptLock(input.key, async () => {
      const receiptPath = this.receiptPath(input.key);
      const requestDigest = digest(input.parameters);
      const existing = await this.readReceipt(receiptPath);
      if (existing) {
        const existingRequestDigest = await this.readReceiptFingerprint(receiptPath);
        if (existingRequestDigest !== requestDigest) {
          return { status: "refused", reason: "idempotency_key_conflict" };
        }
        return { status: "receipt", receipt: existing, replayed: true };
      }

      const preparation = await prepare();
      if (preparation.status === "refused") {
        return preparation;
      }
      const timestamp = new Date().toISOString();
      const pending: AgentTurnContinuationReceipt = {
        key: input.key,
        agentId: preparation.agentId,
        turnId: preparation.turnId,
        newTurnId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        configDigest: preparation.configDigest,
        state: "pending",
      };
      try {
        await this.writeReceipt(receiptPath, requestDigest, pending);
      } catch (error) {
        preparation.release();
        throw error;
      }

      try {
        const newTurnId = await preparation.start();
        const started = {
          ...pending,
          newTurnId,
          updatedAt: new Date().toISOString(),
          state: "started" as const,
        };
        try {
          await this.writeReceipt(receiptPath, requestDigest, started);
          return { status: "receipt", receipt: started, replayed: false };
        } catch {
          // The durable pending marker prevents a replay from sending again.
          return { status: "receipt", receipt: pending, replayed: false };
        }
      } catch {
        const outcomeUnknown = {
          ...pending,
          updatedAt: new Date().toISOString(),
          state: "outcome_unknown" as const,
        };
        try {
          await this.writeReceipt(receiptPath, requestDigest, outcomeUnknown);
          return { status: "receipt", receipt: outcomeUnknown, replayed: false };
        } catch {
          return { status: "receipt", receipt: pending, replayed: false };
        }
      } finally {
        preparation.release();
      }
    });
  }

  private agentPath(agentId: string): string {
    return path.join(this.directory, "turn-observations", filenameFor(agentId));
  }

  private receiptPath(key: string): string {
    return path.join(this.directory, "turn-continuation-receipts", filenameFor(key));
  }

  private async readJournal(agentId: string): Promise<z.infer<typeof JournalSchema>> {
    const journal = await readJsonFile(this.agentPath(agentId), JournalSchema);
    return journal ?? { version: 1, nextOrder: 0, turns: [] };
  }

  private async writeJournal(agentId: string, value: z.infer<typeof JournalSchema>): Promise<void> {
    await writeJsonFileAtomic(this.agentPath(agentId), JournalSchema.parse(value));
  }

  private async readReceipt(file: string): Promise<AgentTurnContinuationReceipt | null> {
    const entry = await readJsonFile(
      file,
      z.object({
        fingerprint: z.string(),
        receipt: ReceiptSchema,
      }),
    );
    return entry?.receipt ?? null;
  }

  private async readReceiptFingerprint(file: string): Promise<string | null> {
    const entry = await readJsonFile(
      file,
      z.object({
        fingerprint: z.string(),
        receipt: ReceiptSchema,
      }),
    );
    return entry?.fingerprint ?? null;
  }

  private async writeReceipt(
    file: string,
    fingerprint: string,
    receipt: AgentTurnContinuationReceipt,
  ): Promise<void> {
    await writeJsonFileAtomic(file, { fingerprint, receipt: ReceiptSchema.parse(receipt) });
  }

  private async withAgentLock<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentTails.get(agentId);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.agentTails.set(agentId, result);
    try {
      return await result;
    } finally {
      if (this.agentTails.get(agentId) === result) this.agentTails.delete(agentId);
    }
  }

  private async withReceiptLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.receiptTails.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(operation);
    this.receiptTails.set(key, result);
    try {
      return await result;
    } finally {
      if (this.receiptTails.get(key) === result) this.receiptTails.delete(key);
    }
  }
}
