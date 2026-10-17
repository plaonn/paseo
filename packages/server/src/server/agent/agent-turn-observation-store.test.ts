import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { AgentTurnObservationStore } from "./agent-turn-observation-store.js";

test("a typed Codex capacity failure with no assistant actions proves no effects", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-observation-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: { model: "gpt-5-codex", thinkingEffort: "high", mode: "default" },
    });
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: "server_overloaded",
      providerClass: null,
      rawMessage: "Selected model is at capacity. Please try a different model.",
    });

    await expect(store.observeTurn("agent-1")).resolves.toMatchObject({
      turnId: "turn-1",
      status: "failed",
      error: {
        providerCode: "server_overloaded",
        normalizedClass: "capacity_overload",
      },
      effects: { state: "none_proven" },
      complete: true,
      truncated: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a tool call makes effects present, while unsupported providers remain unknown", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-observation-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: { model: "gpt-5-codex", thinkingEffort: "high", mode: "default" },
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "tool_call",
      callId: "call-1",
      name: "exec_command",
      status: "running",
      error: null,
      detail: { type: "shell", command: "touch result.txt" },
    });
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: null,
      providerClass: null,
      rawMessage: "failed after tool call",
    });

    await expect(store.observeTurn("agent-1")).resolves.toMatchObject({
      effects: {
        state: "present",
        toolCalls: [{ callId: "call-1", name: "exec_command", status: "running" }],
        shellCommands: [{ command: "touch result.txt", status: "running" }],
      },
      complete: true,
    });

    await store.startTurn({
      agentId: "agent-2",
      turnId: "turn-2",
      workspaceId: "workspace-1",
      provider: "claude",
      config: { model: "claude-sonnet", thinkingEffort: "auto", mode: "default" },
    });
    await store.finishTurn({
      agentId: "agent-2",
      turnId: "turn-2",
      status: "failed",
      providerCode: null,
      providerClass: null,
      rawMessage: "failed",
    });
    await expect(store.observeTurn("agent-2")).resolves.toMatchObject({
      effects: { state: "unknown" },
      complete: false,
      truncated: false,
    });

    await store.startTurn({
      agentId: "agent-3",
      turnId: "turn-3",
      workspaceId: "workspace-1",
      provider: "codex",
      config: { model: "gpt-5-codex", thinkingEffort: "high", mode: "default" },
    });
    await store.finishTurn({
      agentId: "agent-3",
      turnId: "turn-3",
      status: "failed",
      providerCode: null,
      providerClass: null,
      rawMessage: "Selected model is at capacity. Please try a different model.",
    });
    await expect(store.observeTurn("agent-3")).resolves.toMatchObject({
      error: { normalizedClass: "unknown" },
      effects: { state: "none_proven" },
    });

    await store.startTurn({
      agentId: "agent-4",
      turnId: "turn-4",
      workspaceId: "workspace-1",
      provider: "codex",
      config: { model: "gpt-5-codex", thinkingEffort: "high", mode: "default" },
    });
    await store.recordMessageDelivery("agent-4", "turn-4", {
      callId: "prompt-delivery-1",
      name: "agent_prompt",
      status: "completed",
    });
    await store.finishTurn({
      agentId: "agent-4",
      turnId: "turn-4",
      status: "failed",
      providerCode: "server_overloaded",
      providerClass: null,
      rawMessage: "failure after a prompt delivery",
    });
    await expect(store.observeTurn("agent-4")).resolves.toMatchObject({
      effects: {
        state: "present",
        messageDeliveries: [
          { callId: "prompt-delivery-1", name: "agent_prompt", status: "completed" },
        ],
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("continuation receipts survive store reload and never send twice", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-receipt-"));
  try {
    let sends = 0;
    const input = {
      key: "controller-attempt-1",
      parameters: { agentId: "agent-1", failedTurnId: "turn-1", prompt: "continue" },
    };
    const prepare = async () => ({
      status: "prepared" as const,
      agentId: "agent-1",
      turnId: "turn-1",
      configDigest: "sha256:config",
      start: async () => {
        sends += 1;
        return "turn-2";
      },
      release: () => undefined,
    });
    const firstStore = new AgentTurnObservationStore(directory);
    const first = await firstStore.runContinuation(input, prepare);
    const reloadedStore = new AgentTurnObservationStore(directory);
    const replay = await reloadedStore.runContinuation(input, async () => {
      throw new Error("a replay must not call its send preparation");
    });
    const conflict = await reloadedStore.runContinuation(
      { ...input, parameters: { ...input.parameters, prompt: "different" } },
      async () => {
        throw new Error("a key conflict must not call its send preparation");
      },
    );

    expect(first).toMatchObject({
      status: "receipt",
      replayed: false,
      receipt: { newTurnId: "turn-2" },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(conflict).toEqual({ status: "refused", reason: "idempotency_key_conflict" });
    expect(sends).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("telemetry persistence failures remain incomplete after the terminal event", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-telemetry-failure-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: { model: "gpt-5-codex", thinkingEffort: "high", mode: "default" },
    });
    await store.markTelemetryIncomplete("agent-1", "turn-1");
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: "server_overloaded",
      providerClass: null,
      rawMessage: "failure",
      telemetryIncomplete: true,
    });

    await expect(store.observeTurn("agent-1")).resolves.toMatchObject({
      status: "failed",
      effects: { state: "unknown", reason: "telemetry_write_failed" },
      complete: false,
      truncated: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
