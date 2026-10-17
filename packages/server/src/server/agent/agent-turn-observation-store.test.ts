import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";

import {
  AgentTurnObservationStore,
  digestAgentTurnConfig,
} from "./agent-turn-observation-store.js";

test("a schema-typed Codex capacity failure with no side effects proves none_proven", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-observation-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: {
        cwd: "/workspace/project",
        features: { serviceTier: "fast" },
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "user_message",
      text: "original prompt",
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "reasoning",
      text: "classify the request",
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "plan",
      text: "inspect first",
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "assistant_message",
      text: "I will inspect the request.",
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "compaction",
      status: "completed",
    });
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: null,
      providerClass: "serverOverloaded",
      providerRawValue: { codexErrorInfo: "serverOverloaded" },
      rawMessage: "Selected model is at capacity. Please try a different model.",
    });

    await expect(
      new AgentTurnObservationStore(directory).observeTurn("agent-1"),
    ).resolves.toMatchObject({
      turnId: "turn-1",
      status: "failed",
      error: {
        providerCode: null,
        providerClass: "serverOverloaded",
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
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "tool_call",
      callId: "call-1",
      name: "exec_command",
      status: "running",
      error: null,
      detail: { type: "shell", command: "touch result.txt" },
    });
    await store.recordTimelineItem("agent-2", "turn-2", {
      type: "tool_call",
      callId: "claude-call",
      name: "exec_command",
      status: "completed",
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
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "claude-sonnet",
        thinkingEffort: "auto",
        mode: "default",
      },
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
      effects: {
        state: "unknown",
        observed: { toolCalls: [], shellCommands: [] },
      },
      complete: false,
      truncated: false,
    });

    await store.startTurn({
      agentId: "agent-3",
      turnId: "turn-3",
      workspaceId: "workspace-1",
      provider: "codex",
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
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
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
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
      providerCode: null,
      providerClass: "serverOverloaded",
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
      agentId: "agent-1",
      turnId: "turn-1",
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
    const secondAttempt = await reloadedStore.runContinuation(
      { ...input, key: "controller-attempt-2" },
      async () => {
        throw new Error("a started receipt must block another key for the same turn");
      },
    );

    expect(first).toMatchObject({
      status: "receipt",
      replayed: false,
      receipt: { newTurnId: "turn-2" },
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(conflict).toEqual({ status: "refused", reason: "idempotency_key_conflict" });
    expect(secondAttempt).toEqual({
      status: "refused",
      reason: "continuation_already_attempted",
    });
    expect(sends).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeline writes batch until terminal state and retain only the latest 32 turns", async () => {
  vi.useFakeTimers();
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-observation-batch-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "tool_call",
      callId: "call-1",
      name: "exec_command",
      status: "running",
      error: null,
      detail: { type: "shell", command: "touch result.txt" },
    });

    await expect(
      new AgentTurnObservationStore(directory).observeTurn("agent-1"),
    ).resolves.toMatchObject({
      status: "running",
      complete: false,
      effects: { state: "unknown", reason: "turn_in_progress" },
    });

    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: null,
      providerClass: null,
      rawMessage: "failed after a tool call",
    });
    await expect(
      new AgentTurnObservationStore(directory).observeTurn("agent-1"),
    ).resolves.toMatchObject({
      effects: { state: "present", shellCommands: [{ command: "touch result.txt" }] },
      complete: true,
    });

    for (let index = 2; index <= 33; index += 1) {
      await store.startTurn({
        agentId: "agent-1",
        turnId: `turn-${index}`,
        workspaceId: "workspace-1",
        provider: "codex",
        config: {
          cwd: "/workspace/project",
          features: {},
          model: "gpt-5-codex",
          thinkingEffort: "high",
          mode: "default",
        },
      });
    }
    await expect(store.observeTurn("agent-1", "turn-1")).resolves.toBeNull();
    await expect(store.observeTurn("agent-1")).resolves.toMatchObject({ turnId: "turn-33" });
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

test("late terminal telemetry is durable before a reloaded store can observe the turn", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-observation-late-event-"));
  try {
    const store = new AgentTurnObservationStore(directory);
    await store.startTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      workspaceId: "workspace-1",
      provider: "codex",
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
    });
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: null,
      providerClass: "serverOverloaded",
      rawMessage: "failure",
    });
    await store.recordTimelineItem("agent-1", "turn-1", {
      type: "tool_call",
      callId: "late-call",
      name: "exec_command",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "touch result.txt" },
    });

    await expect(
      new AgentTurnObservationStore(directory).observeTurn("agent-1"),
    ).resolves.toMatchObject({
      effects: { state: "present", shellCommands: [{ callId: "late-call" }] },
      complete: true,
    });

    await store.markTelemetryIncomplete("agent-1", "turn-1");
    await expect(
      new AgentTurnObservationStore(directory).observeTurn("agent-1"),
    ).resolves.toMatchObject({
      effects: { state: "unknown", reason: "telemetry_incomplete" },
      complete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config digest includes cwd and provider feature values", () => {
  const baseline = {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    provider: "codex",
    cwd: "/workspace/project",
    features: { serviceTier: "default", fast: false },
    model: "gpt-5-codex",
    thinkingEffort: "high",
    mode: "default",
  };
  expect(digestAgentTurnConfig({ ...baseline, cwd: "/workspace/other" })).not.toBe(
    digestAgentTurnConfig(baseline),
  );
  expect(
    digestAgentTurnConfig({ ...baseline, features: { ...baseline.features, fast: true } }),
  ).not.toBe(digestAgentTurnConfig(baseline));
});

test("a pending crash-window receipt blocks a different key after store reload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-turn-receipt-crash-window-"));
  try {
    let sends = 0;
    const firstInput = {
      key: "controller-attempt-before-crash",
      agentId: "agent-1",
      turnId: "turn-1",
      parameters: { agentId: "agent-1", failedTurnId: "turn-1", prompt: "continue" },
    };
    const firstStore = new AgentTurnObservationStore(directory);
    const outcomeUnknown = await firstStore.runContinuation(firstInput, async () => ({
      status: "prepared" as const,
      agentId: "agent-1",
      turnId: "turn-1",
      configDigest: "sha256:config",
      start: async () => {
        sends += 1;
        throw new Error("provider accepted prompt; daemon lost the start result");
      },
      release: () => undefined,
    }));

    const reloadedStore = new AgentTurnObservationStore(directory);
    const differentKey = await reloadedStore.runContinuation(
      {
        ...firstInput,
        key: "controller-attempt-after-restart",
        parameters: { ...firstInput.parameters, attempt: 2 },
      },
      async () => {
        throw new Error("a new key must not reach provider preparation");
      },
    );

    expect(outcomeUnknown).toMatchObject({
      status: "receipt",
      receipt: { state: "outcome_unknown", turnId: "turn-1" },
    });
    expect(differentKey).toEqual({
      status: "refused",
      reason: "continuation_already_attempted",
    });
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
      config: {
        cwd: "/workspace/project",
        features: {},
        model: "gpt-5-codex",
        thinkingEffort: "high",
        mode: "default",
      },
    });
    await store.markTelemetryIncomplete("agent-1", "turn-1");
    await store.finishTurn({
      agentId: "agent-1",
      turnId: "turn-1",
      status: "failed",
      providerCode: null,
      providerClass: "serverOverloaded",
      rawMessage: "failure",
      telemetryIncomplete: true,
    });

    await expect(store.observeTurn("agent-1")).resolves.toMatchObject({
      status: "failed",
      effects: { state: "unknown", reason: "telemetry_incomplete" },
      complete: false,
      truncated: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
