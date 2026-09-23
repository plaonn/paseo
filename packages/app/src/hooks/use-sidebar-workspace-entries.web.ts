import { refreshProviderSubagents, useProviderSubagentStore } from "@/subagents/provider-store";
import { buildWorkspaceAgentActivityIndex } from "@/utils/workspace-agent-activity.web";
import { useEffect, useMemo, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore } from "@/stores/session-store";
import {
  areSidebarWorkspaceSessionsEqual,
  buildSidebarWorkspaceEntries,
  selectSidebarWorkspaceSessions,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacePlacement,
  type SidebarWorkspaceSession,
} from "./sidebar-workspaces-view-model.web";

const EMPTY_ENTRIES = new Map<string, SidebarWorkspaceEntry>();
const EMPTY_SESSIONS: SidebarWorkspaceSession[] = [];
const EMPTY_PENDING_CREATE_ATTEMPTS: Record<string, never> = {};

export function useSidebarWorkspaceEntries(
  placements: readonly SidebarWorkspacePlacement[],
  enabled = true,
): ReadonlyMap<string, SidebarWorkspaceEntry> {
  const serverIds = useMemo(
    () => Array.from(new Set(placements.map((placement) => placement.serverId))),
    [placements],
  );
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      enabled ? selectSidebarWorkspaceSessions(state.sessions, serverIds) : EMPTY_SESSIONS,
    areSidebarWorkspaceSessionsEqual,
  );
  const providerDescriptors = useProviderSubagentStore((state) => state.descriptors);
  const hydrated = useRef(new WeakMap<object, Set<string>>());
  useEffect(() => {
    if (!enabled) return;
    for (const session of sessions) {
      const live = useSessionStore.getState().sessions[session.serverId];
      const client = live?.client;
      if (!client || !live.serverInfo?.features?.providerSubagents) continue;
      let ids = hydrated.current.get(client);
      if (!ids) {
        ids = new Set();
        hydrated.current.set(client, ids);
      }
      for (const agent of session.agents?.values() ?? []) {
        if (agent.archivedAt || ids.has(agent.id)) continue;
        ids.add(agent.id);
        const requested = ids;
        void refreshProviderSubagents(client, session.serverId, agent.id).catch(() =>
          requested.delete(agent.id),
        );
      }
    }
  }, [enabled, sessions]);
  const pendingCreateAttempts = useCreateFlowStore((state) =>
    enabled ? state.pendingByDraftId : EMPTY_PENDING_CREATE_ATTEMPTS,
  );
  const previousEntriesRef = useRef<ReadonlyMap<string, SidebarWorkspaceEntry>>(EMPTY_ENTRIES);

  // Collection ownership is intentional: retained sidebars have one cheap
  // subscription to structurally shared indexes, never one session-store
  // subscription per mounted row.
  return useMemo(() => {
    if (!enabled) {
      return previousEntriesRef.current;
    }
    if (placements.length === 0 || sessions.length === 0) {
      previousEntriesRef.current = EMPTY_ENTRIES;
      return EMPTY_ENTRIES;
    }
    const entries = buildSidebarWorkspaceEntries({
      placements,
      sessions: sessions.map((session) => ({
        ...session,
        workspaceAgentActivity: session.agents
          ? buildWorkspaceAgentActivityIndex(
              session.agents,
              session.workspaceAgentActivity,
              [...providerDescriptors.entries()]
                .filter(([key]) => key.startsWith(`${session.serverId}\0`))
                .map(([, value]) => value),
            )
          : session.workspaceAgentActivity,
      })),
      pendingCreateAttempts,
      previousEntries: previousEntriesRef.current,
    });
    previousEntriesRef.current = entries;
    return entries;
  }, [enabled, pendingCreateAttempts, placements, sessions, providerDescriptors]);
}
