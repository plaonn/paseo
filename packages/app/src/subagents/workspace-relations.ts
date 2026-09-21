import {
  ARCHIVED_PARENT_WORKSPACE_ID_LABEL,
  ARCHIVED_PARENT_WORKSPACE_NAME_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";

export type RelationAgent = Pick<
  Agent,
  "id" | "workspaceId" | "parentAgentId" | "status" | "archivedAt" | "pendingPermissions" | "labels"
> & {
  turn: Pick<Agent["turn"], "phase">;
};

export interface WorkspaceRelations {
  running: number;
  total: number;
  attention: number;
  parentWorkspaceIds: string[];
  missingParent: boolean;
  providerParentIds: string[];
  formerParentNames: string[];
}

export function summarizeWorkspaceRelations(
  workspaceId: string,
  agents: ReadonlyMap<string, RelationAgent>,
  providerChildren: readonly ProviderSubagentDescriptorPayload[],
): WorkspaceRelations {
  const local = [...agents.values()].filter((a) => a.workspaceId === workspaceId && !a.archivedAt);
  const localIds = new Set(local.map((a) => a.id));
  const roots = local.filter((a) => !a.parentAgentId || !localIds.has(a.parentAgentId));
  const reached = new Set(roots.map((a) => a.id));
  const descendants = new Map<string, RelationAgent>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of agents.values()) {
      if (!a.archivedAt && a.parentAgentId && reached.has(a.parentAgentId) && !reached.has(a.id)) {
        reached.add(a.id);
        descendants.set(a.id, a);
        changed = true;
      }
    }
  }
  const children = [...descendants.values()].filter((a) => !a.archivedAt);
  const provider = providerChildren.filter(
    (a) => reached.has(a.parentAgentId) && !agents.get(a.parentAgentId)?.archivedAt,
  );
  const parents = roots.map((a) => (a.parentAgentId ? agents.get(a.parentAgentId) : undefined));
  const workerOnly = roots.length > 0 && roots.every((a) => a.parentAgentId !== null);
  const parentWorkspaceIds = workerOnly
    ? [
        ...new Set(
          parents.flatMap((a) =>
            a?.workspaceId && a.workspaceId !== workspaceId ? [a.workspaceId] : [],
          ),
        ),
      ].sort()
    : [];
  return {
    formerParentNames:
      roots.length &&
      roots.every((a) => !a.parentAgentId && a.labels[ARCHIVED_PARENT_WORKSPACE_ID_LABEL])
        ? [
            ...new Set(
              roots.map(
                (a) =>
                  a.labels[ARCHIVED_PARENT_WORKSPACE_NAME_LABEL] ||
                  a.labels[ARCHIVED_PARENT_WORKSPACE_ID_LABEL],
              ),
            ),
          ]
        : [],
    providerParentIds: [...reached].filter((id) => !agents.get(id)?.archivedAt).sort(),
    total: children.length + provider.length,
    running:
      children.filter((a) => a.turn.phase === "open" || a.status === "initializing").length +
      provider.filter((a) => a.status === "running").length,
    attention:
      children.filter((a) => a.pendingPermissions.length > 0 || a.status === "error").length +
      provider.filter((a) => a.status === "failed").length,
    parentWorkspaceIds,
    missingParent: workerOnly && parents.some((a) => !a?.workspaceId),
  };
}
