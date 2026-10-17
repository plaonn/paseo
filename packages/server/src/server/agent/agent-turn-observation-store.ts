import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
  // Deprecated informational compatibility field. It remains zero.
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
  providerRawValue: z.unknown().nullable().optional(),
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
  cwd: z.string().nullable().optional(),
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
  turnObservationUnavailable: z.boolean().optional(),
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
const ReceiptLedgerEntrySchema = z.object({
  fingerprint: z.string(),
  receipt: ReceiptSchema,
});
const ReceiptLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(ReceiptLedgerEntrySchema),
});

const MAX_RETAINED_TURNS = 32;
const JOURNAL_WRITE_DEBOUNCE_MS = 75;

export type AgentTurnObservation = z.infer<typeof TurnObservationSchema>;
export type AgentTurnEffects = z.infer<typeof EffectsSchema>;
export type AgentTurnEffectManifest = z.infer<typeof EffectManifestSchema>;
export type AgentTurnProviderError = z.infer<typeof ProviderErrorSchema>;
export type AgentTurnContinuationReceipt = z.infer<typeof ReceiptSchema>;
type AgentTurnJournal = z.infer<typeof JournalSchema>;

export interface AgentTurnConfigSnapshot {
  model: string | null;
  thinkingEffort: string | null;
  mode: string | null;
  cwd?: string | null;
  features?: Record<string, unknown>;
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
  providerRawValue?: unknown;
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
  cwd?: string | null;
  features?: Record<string, unknown>;
  model: string | null;
  thinkingEffort: string | null;
  mode: string | null;
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        ...input,
        cwd: input.cwd ?? null,
        features: input.features ?? {},
      }),
    )
    .digest("hex");
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
    manifest.subAgentSpawns.length > 0
  );
}

function markObservationTelemetryIncomplete(observation: AgentTurnObservation): void {
  observation.telemetryFailed = true;
  observation.complete = false;
  observation.effects = {
    state: "unknown",
    reason: "telemetry_incomplete",
    observed: manifestFromEffects(observation.effects),
  };
}

function poisonLatestObservation(journal: AgentTurnJournal): AgentTurnObservation | null {
  const latest = journal.turns.at(-1);
  if (!latest) {
    journal.turnObservationUnavailable = true;
    return null;
  }
  markObservationTelemetryIncomplete(latest);
  return latest;
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
  else if (observation.telemetryFailed) reason = "telemetry_incomplete";
  return { state: "unknown", reason, observed: manifest };
}

function providerError(
  observation: AgentTurnObservation,
  input: AgentTurnFinishInput,
): AgentTurnProviderError | null {
  if (input.status !== "failed") return null;
  const normalizedClass =
    observation.provider === "codex" && input.providerClass === "serverOverloaded"
      ? "capacity_overload"
      : "unknown";
  return {
    providerCode: input.providerCode,
    providerClass: input.providerClass,
    providerRawValue: input.providerRawValue ?? null,
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
  if (item.type === "tool_call") {
    if (item.detail.type === "plan") {
      observation.effects = observeEffects(observation, manifest);
      return;
    }
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
  private readonly journalCache = new Map<string, z.infer<typeof JournalSchema>>();
  private readonly journalFlushTimers = new Map<string, NodeJS.Timeout>();
  private readonly journalWriteGenerations = new Map<string, number>();
  private receiptLedgerTail: Promise<unknown> = Promise.resolve();
  private receiptLedger: z.infer<typeof ReceiptLedgerSchema> | null = null;

  constructor(private readonly directory: string) {}

  async startTurn(input: AgentTurnStartInput): Promise<void> {
    await this.withAgentLock(input.agentId, async () => {
      const journal = await this.readJournal(input.agentId);
      const existing = journal.turns.find((turn) => turn.turnId === input.turnId);
      if (existing) return;
      const priorTelemetryUnavailable = journal.turnObservationUnavailable === true;
      if (priorTelemetryUnavailable) delete journal.turnObservationUnavailable;
      const startedAt = input.startedAt ?? new Date().toISOString();
      const config = {
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        cwd: input.config.cwd ?? null,
        features: input.config.features ?? {},
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
        cwd: input.config.cwd ?? null,
        configDigest: digestAgentTurnConfig(config),
        configComplete:
          input.provider.length > 0 &&
          typeof input.config.cwd === "string" &&
          input.config.cwd.length > 0 &&
          input.config.features !== undefined &&
          input.config.model !== null &&
          input.config.thinkingEffort !== null &&
          input.config.mode !== null,
        startedAt,
        finishedAt: null,
        error: null,
        effects: {
          state: "unknown",
          reason: priorTelemetryUnavailable ? "telemetry_incomplete" : "turn_in_progress",
          observed: emptyManifest(),
        },
        complete: false,
        truncated: false,
        telemetryFailed: priorTelemetryUnavailable,
      };
      journal.nextOrder += 1;
      journal.turns.push(observation);
      if (journal.turns.length > MAX_RETAINED_TURNS) {
        journal.turns.splice(0, journal.turns.length - MAX_RETAINED_TURNS);
      }
      await this.writeJournal(input.agentId, journal);
    });
  }

  async recordTimelineItem(
    agentId: string,
    turnId: string | undefined,
    item: AgentTimelineItem,
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = turnId ? journal.turns.find((turn) => turn.turnId === turnId) : undefined;
      if (!observation) {
        poisonLatestObservation(journal);
        await this.writeJournal(agentId, journal);
        return;
      }
      if (observation.provider !== "codex") return;
      applyTimelineItem(observation, item);
      if (observation.telemetryFailed) {
        observation.complete = false;
        observation.effects = {
          state: "unknown",
          reason: "telemetry_incomplete",
          observed: manifestFromEffects(observation.effects),
        };
      }
      if (observation.status === "running") this.scheduleJournalWrite(agentId);
      else await this.writeJournal(agentId, journal);
    });
  }

  async markTelemetryIncomplete(agentId: string, turnId?: string): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = turnId ? journal.turns.find((turn) => turn.turnId === turnId) : undefined;
      const poisoned = observation ?? poisonLatestObservation(journal);
      if (!poisoned) {
        await this.writeJournal(agentId, journal);
        return;
      }
      if (!observation) {
        await this.writeJournal(agentId, journal);
        return;
      }
      markObservationTelemetryIncomplete(observation);
      if (observation.status === "running") this.scheduleJournalWrite(agentId);
      else await this.writeJournal(agentId, journal);
    });
  }

  async recordSubAgentSpawn(
    agentId: string,
    turnId: string | undefined,
    subAgentId: string,
    status: "running" | "completed" | "failed" | "canceled" = "running",
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = turnId ? journal.turns.find((turn) => turn.turnId === turnId) : undefined;
      if (!observation) {
        poisonLatestObservation(journal);
        await this.writeJournal(agentId, journal);
        return;
      }
      if (observation.provider !== "codex") return;
      const manifest = manifestFromEffects(observation.effects);
      const existingIndex = manifest.subAgentSpawns.findIndex((entry) => entry.id === subAgentId);
      if (existingIndex === -1) manifest.subAgentSpawns.push({ id: subAgentId, status });
      else manifest.subAgentSpawns[existingIndex] = { id: subAgentId, status };
      observation.effects =
        observation.provider === "codex" && !observation.telemetryFailed
          ? { state: "present", ...manifest }
          : {
              state: "unknown",
              reason: observation.telemetryFailed ? "telemetry_incomplete" : "provider_unverified",
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
        if (observation.provider !== "codex") continue;
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
                  ? "telemetry_incomplete"
                  : "provider_unverified",
                observed: manifest,
              };
        changed = true;
      }
      if (changed) {
        await this.writeJournal(agentId, journal);
      } else {
        poisonLatestObservation(journal);
        await this.writeJournal(agentId, journal);
      }
      return changed;
    });
  }

  async recordMessageDelivery(
    agentId: string,
    turnId: string | undefined,
    delivery: {
      callId: string;
      name: string;
      status: "running" | "completed" | "failed" | "canceled";
    },
  ): Promise<void> {
    await this.withAgentLock(agentId, async () => {
      const journal = await this.readJournal(agentId);
      const observation = turnId ? journal.turns.find((turn) => turn.turnId === turnId) : undefined;
      if (!observation) {
        poisonLatestObservation(journal);
        await this.writeJournal(agentId, journal);
        return;
      }
      if (observation.provider !== "codex") return;
      const manifest = manifestFromEffects(observation.effects);
      upsertById(manifest.messageDeliveries, delivery);
      observation.effects =
        observation.provider === "codex" && !observation.telemetryFailed
          ? { state: "present", ...manifest }
          : {
              state: "unknown",
              reason: observation.telemetryFailed ? "telemetry_incomplete" : "provider_unverified",
              observed: manifest,
            };
      await this.writeJournal(agentId, journal);
    });
  }

  async finishTurn(input: AgentTurnFinishInput): Promise<void> {
    await this.withAgentLock(input.agentId, async () => {
      const journal = await this.readJournal(input.agentId);
      const observation = journal.turns.find((turn) => turn.turnId === input.turnId);
      if (!observation) {
        poisonLatestObservation(journal);
        await this.writeJournal(input.agentId, journal);
        return;
      }
      observation.telemetryFailed =
        observation.telemetryFailed || input.telemetryIncomplete === true;
      observation.status = input.status;
      observation.finishedAt = input.finishedAt ?? new Date().toISOString();
      observation.error = providerError(observation, input);
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
    input: { key: string; agentId: string; turnId: string; parameters: unknown },
    prepare: () => Promise<AgentTurnContinuationPreparation>,
  ): Promise<AgentTurnContinuationResult> {
    if (!input.key.trim() || input.key.length > 200) {
      return { status: "refused", reason: "invalid_idempotency_key" };
    }
    return this.withReceiptLedgerLock(async () => {
      const requestDigest = digest(input.parameters);
      const ledger = await this.readReceiptLedger();
      const existing = ledger.entries.find((entry) => entry.receipt.key === input.key);
      if (existing) {
        if (existing.fingerprint !== requestDigest) {
          return { status: "refused", reason: "idempotency_key_conflict" };
        }
        return { status: "receipt", receipt: existing.receipt, replayed: true };
      }

      const previousAttempt = ledger.entries.find(
        (entry) => entry.receipt.agentId === input.agentId && entry.receipt.turnId === input.turnId,
      );
      if (previousAttempt) {
        return { status: "refused", reason: "continuation_already_attempted" };
      }

      const preparation = await prepare();
      if (preparation.status === "refused") {
        return preparation;
      }
      if (preparation.agentId !== input.agentId || preparation.turnId !== input.turnId) {
        preparation.release();
        return { status: "refused", reason: "turn_mismatch" };
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
      const pendingEntry = { fingerprint: requestDigest, receipt: pending };
      ledger.entries.push(pendingEntry);
      try {
        await this.writeReceiptLedger(ledger);
      } catch (error) {
        ledger.entries.pop();
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
        pendingEntry.receipt = started;
        try {
          await this.writeReceiptLedger(ledger);
          return { status: "receipt", receipt: started, replayed: false };
        } catch {
          pendingEntry.receipt = pending;
          return { status: "receipt", receipt: pending, replayed: false };
        }
      } catch {
        const outcomeUnknown = {
          ...pending,
          updatedAt: new Date().toISOString(),
          state: "outcome_unknown" as const,
        };
        pendingEntry.receipt = outcomeUnknown;
        try {
          await this.writeReceiptLedger(ledger);
          return { status: "receipt", receipt: outcomeUnknown, replayed: false };
        } catch {
          pendingEntry.receipt = pending;
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

  private receiptLedgerPath(): string {
    return path.join(this.directory, "turn-continuation-receipts", "ledger.json");
  }

  private async readJournal(agentId: string): Promise<z.infer<typeof JournalSchema>> {
    const cached = this.journalCache.get(agentId);
    if (cached) return cached;
    const loaded = await readJsonFile(this.agentPath(agentId), JournalSchema);
    const journal = loaded ?? { version: 1 as const, nextOrder: 0, turns: [] };
    if (journal.turns.length > MAX_RETAINED_TURNS) {
      journal.turns.splice(0, journal.turns.length - MAX_RETAINED_TURNS);
      this.journalCache.set(agentId, journal);
      await this.writeJournal(agentId, journal);
      return journal;
    }
    this.journalCache.set(agentId, journal);
    return journal;
  }

  private async writeJournal(agentId: string, value: z.infer<typeof JournalSchema>): Promise<void> {
    this.cancelScheduledJournalWrite(agentId);
    const validated = JournalSchema.parse(value);
    await writeJsonFileAtomic(this.agentPath(agentId), validated);
    this.journalCache.set(agentId, validated);
  }

  private async readReceiptLedger(): Promise<z.infer<typeof ReceiptLedgerSchema>> {
    if (this.receiptLedger) return this.receiptLedger;
    const current = await readJsonFile(this.receiptLedgerPath(), ReceiptLedgerSchema);
    if (current) {
      this.receiptLedger = current;
      return current;
    }

    const entries: z.infer<typeof ReceiptLedgerEntrySchema>[] = [];
    let files: string[] = [];
    try {
      files = await readdir(path.dirname(this.receiptLedgerPath()));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    for (const name of files) {
      if (!name.endsWith(".json") || name === "ledger.json") continue;
      const entry = await readJsonFile(
        path.join(path.dirname(this.receiptLedgerPath()), name),
        ReceiptLedgerEntrySchema,
      );
      if (entry) entries.push(entry);
    }
    const ledger = { version: 1 as const, entries };
    if (entries.length > 0) await this.writeReceiptLedger(ledger);
    this.receiptLedger = ledger;
    return ledger;
  }

  private async writeReceiptLedger(ledger: z.infer<typeof ReceiptLedgerSchema>): Promise<void> {
    const validated = ReceiptLedgerSchema.parse(ledger);
    await writeJsonFileAtomic(this.receiptLedgerPath(), validated);
    this.receiptLedger = validated;
  }

  private scheduleJournalWrite(agentId: string): void {
    const current = this.journalFlushTimers.get(agentId);
    if (current) clearTimeout(current);
    const generation = (this.journalWriteGenerations.get(agentId) ?? 0) + 1;
    this.journalWriteGenerations.set(agentId, generation);
    const timer = setTimeout(() => {
      this.journalFlushTimers.delete(agentId);
      void this.withAgentLock(agentId, async () => {
        if (this.journalWriteGenerations.get(agentId) !== generation) return;
        const journal = this.journalCache.get(agentId);
        if (journal)
          await writeJsonFileAtomic(this.agentPath(agentId), JournalSchema.parse(journal));
      }).catch(() => {
        // An unflushed active turn remains durably marked running and incomplete.
      });
    }, JOURNAL_WRITE_DEBOUNCE_MS);
    this.journalFlushTimers.set(agentId, timer);
  }

  private cancelScheduledJournalWrite(agentId: string): void {
    const timer = this.journalFlushTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.journalFlushTimers.delete(agentId);
    this.journalWriteGenerations.set(agentId, (this.journalWriteGenerations.get(agentId) ?? 0) + 1);
  }

  private async withReceiptLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.receiptLedgerTail;
    const result = previous.catch(() => undefined).then(operation);
    this.receiptLedgerTail = result;
    try {
      return await result;
    } finally {
      if (this.receiptLedgerTail === result) this.receiptLedgerTail = Promise.resolve();
    }
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
}
