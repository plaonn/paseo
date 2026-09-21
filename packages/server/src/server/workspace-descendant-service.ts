import type { PersistedConfig } from "./persisted-config.js";
import {
  ARCHIVED_PARENT_WORKSPACE_ID_LABEL,
  ARCHIVED_PARENT_WORKSPACE_NAME_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import type { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  captureScope,
  sweepArchives,
  validJournal,
  type Agent,
  type Journal,
} from "./workspace-descendant-cleanup.js";

interface Options {
  paseoHome: string;
  agentManager: Pick<
    AgentManager,
    "listAgents" | "getAgent" | "listProviderSubagents" | "subscribe" | "updateAgentMetadata"
  >;
  agentStorage: Pick<AgentStorage, "list">;
  workspaceRegistry: FileBackedWorkspaceRegistry;
  terminalManager: Pick<TerminalManager, "getTerminals" | "subscribeTerminalsChanged">;
  workspaceGitService: Pick<WorkspaceGitServiceImpl, "onSnapshotUpdated">;
  enabled(): boolean;
  archive(workspaceId: string): Promise<unknown>;
  logger: Logger;
}

/** Captures ownership before native archive can detach cross-workspace children. */
export async function startWorkspaceDescendantService(options: Options) {
  const { agentManager, agentStorage, workspaceRegistry, terminalManager } = options;
  const file = join(options.paseoHome, "workspace-descendant-archives.json");
  let journal: Journal = {};
  try {
    journal = validJournal(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let stopped = false;
  let dirty = false;
  let draining: Promise<void> | undefined;
  let writes = Promise.resolve();
  const captures = new Set<string>();
  const save = () => {
    const snapshot = structuredClone(journal);
    const task = writes.then(() => writeJsonFileAtomic(file, snapshot));
    writes = task;
    return task;
  };
  async function agents(): Promise<Agent[]> {
    const rows = new Map(
      (await agentStorage.list())
        .filter((a) => !a.internal)
        .map((a) => [
          a.id,
          {
            id: a.id,
            workspaceId: a.workspaceId,
            parent: a.labels["paseo.parent-agent-id"],
            status: a.lastStatus,
            permissions: a.attentionReason === "permission" ? 1 : 0,
            archived: Boolean(a.archivedAt),
            lastUserMessageAt: a.lastUserMessageAt,
          },
        ]),
    );
    for (const a of agentManager.listAgents()) {
      if (a.internal) continue;
      const stored = rows.get(a.id);
      rows.set(a.id, {
        id: a.id,
        workspaceId: a.workspaceId,
        parent: a.labels["paseo.parent-agent-id"],
        status: a.lifecycle,
        permissions: a.pendingPermissions.size,
        archived: stored?.archived ?? false,
        lastUserMessageAt: a.lastUserMessageAt?.toISOString() ?? null,
      });
    }
    return [...rows.values()];
  }
  const workspaces = async () =>
    (await workspaceRegistry.list())
      .filter((w) => !w.archivedAt)
      .map((w) => ({
        id: w.workspaceId,
        workspaceDirectory: w.cwd,
        pinnedAt: w.pinnedAt,
        archivingAt: workspaceRegistry.isArchiving(w.workspaceId) ? "pending" : null,
      }));
  async function providerBusy(id: string, snapshot: Agent[]) {
    for (const a of snapshot.filter(
      (candidate) => candidate.workspaceId === id && !candidate.archived,
    )) {
      // A stored closed session has no running runtime; other unloaded states remain retained.
      if (!agentManager.getAgent(a.id)) {
        if (a.status !== "closed") return true;
        continue;
      }
      if (
        agentManager
          .listProviderSubagents(a.id)
          .some((s) => !["completed", "canceled"].includes(s.status))
      )
        return true;
    }
    return false;
  }
  async function drain() {
    try {
      while (dirty) {
        if (stopped || !options.enabled()) break;
        dirty = false;
        await sweepArchives(
          {
            terminals: async (id) => {
              const w = await workspaceRegistry.get(id);
              return (
                !w || (await terminalManager.getTerminals(w.cwd, { workspaceId: id })).length > 0
              );
            },
            archive: async (id) => {
              await options.archive(id);
            },
          },
          journal,
          {
            agents,
            workspaces,
            save,
            providerBusy,

            cancelled: () => stopped || !options.enabled(),
          },
        );
      }
    } catch (error) {
      options.logger.warn(
        { err: error },
        "Descendant workspace cleanup retained pending workspaces",
      );
    } finally {
      draining = undefined;
    }
  }
  function wake() {
    if (stopped || !options.enabled()) return;
    dirty = true;
    if (!draining) draining = Promise.resolve().then(drain);
  }
  const unsubscribePrepare = workspaceRegistry.subscribeToArchiveRequests(async (ids) => {
    if (stopped || !options.enabled()) return;
    const snapshot = await agents();
    for (const id of ids) {
      if (journal[id]?.confirmed || Object.keys(journal[id]?.operations ?? {}).length) continue;
      const scope = captureScope(id, snapshot, new Date().toISOString());
      if (!scope || !scope.subtreeIds?.length) continue;
      for (const [childId, binding] of Object.entries(scope.bindings ?? {})) {
        const parent = snapshot.find((a) => a.id === binding.parent);
        if (!parent?.workspaceId || parent.workspaceId === binding.workspaceId) continue;
        const parentWorkspace = await workspaceRegistry.get(parent.workspaceId);
        if (!parentWorkspace) continue;
        await agentManager.updateAgentMetadata(childId, {
          labels: {
            [ARCHIVED_PARENT_WORKSPACE_ID_LABEL]: parent.workspaceId,
            [ARCHIVED_PARENT_WORKSPACE_NAME_LABEL]:
              parentWorkspace.title ?? parentWorkspace.displayName,
          },
        });
      }
      journal[id] = scope;
      await save();
      captures.add(id);
    }
  });
  const unsubscribeWorkspace = workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "archive" && captures.delete(mutation.workspaceId)) {
      journal[mutation.workspaceId].confirmed = true;
      await save();
    }
    wake();
  });
  const unsubscribeAgent = agentManager.subscribe(
    (event) => {
      if (
        event.type === "agent_state" ||
        (event.type === "provider_subagent" && event.event.type !== "timeline")
      )
        wake();
    },
    { replayState: false },
  );
  const unsubscribeTerminal = terminalManager.subscribeTerminalsChanged(wake);
  const gitSubscription = options.workspaceGitService.onSnapshotUpdated(wake);
  wake();
  return {
    async stop() {
      stopped = true;
      unsubscribePrepare();
      unsubscribeWorkspace();
      unsubscribeAgent();
      unsubscribeTerminal();
      gitSubscription.unsubscribe();
      await draining;
      await writes;
    },
  };
}

export function descendantArchiveEnabled(config: PersistedConfig): boolean {
  // COMPAT(workspace-status-plugin): added in v0.9.0, remove after 2027-03-21.
  // Migration must retire the external archive owner before enabling the native one.
  const legacyOwner =
    config.pluginsEnabled === true &&
    config.plugins?.["workspace-status"] !== undefined &&
    config.plugins["workspace-status"].enabled !== false;
  return config.daemon?.autoArchiveDescendantWorkspaces === true && !legacyOwner;
}
