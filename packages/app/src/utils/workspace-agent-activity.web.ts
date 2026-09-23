import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import { aggregateSidebarStateBuckets, deriveSidebarStateBucket } from "./sidebar-agent-state";

export interface WorkspaceAgentActivity {
  agentId: string;
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

function workspaceAgentStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

export function buildWorkspaceAgentActivityIndex(
  agents: ReadonlyMap<string, Agent>,
  previous?: ReadonlyMap<string, WorkspaceAgentActivity>,
  providerChildren: readonly ProviderSubagentDescriptorPayload[] = [],
): Map<string, WorkspaceAgentActivity> {
  const activityByWorkspaceId = new Map<string, WorkspaceAgentActivity>();
  const latestActivityAtByWorkspaceId = new Map<string, Date>();

  for (const agent of agents.values()) {
    const parentAgent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
    if (agent.archivedAt || !agent.workspaceId || !isWorkspaceRootAgent(agent, parentAgent)) {
      continue;
    }

    const enteredAt = agent.attentionTimestamp ?? agent.updatedAt;
    const latestActivityAt = latestActivityAtByWorkspaceId.get(agent.workspaceId);
    if (latestActivityAt && enteredAt <= latestActivityAt) {
      continue;
    }
    latestActivityAtByWorkspaceId.set(agent.workspaceId, enteredAt);

    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    activityByWorkspaceId.set(agent.workspaceId, {
      agentId: agent.id,
      status,
      enteredAt,
    });
  }

  addDescendantActivity(agents, activityByWorkspaceId, providerChildren);

  for (const [workspaceId, activity] of activityByWorkspaceId) {
    const previousActivity = previous?.get(workspaceId);
    if (
      previousActivity?.agentId === activity.agentId &&
      previousActivity.status === activity.status
    ) {
      activityByWorkspaceId.set(workspaceId, previousActivity);
    }
  }

  if (previous && areWorkspaceAgentActivityIndexesIdentical(previous, activityByWorkspaceId)) {
    return previous instanceof Map ? previous : new Map(previous);
  }
  return activityByWorkspaceId;
}

function areWorkspaceAgentActivityIndexesIdentical(
  previous: ReadonlyMap<string, WorkspaceAgentActivity>,
  next: ReadonlyMap<string, WorkspaceAgentActivity>,
): boolean {
  if (previous.size !== next.size) {
    return false;
  }
  for (const [workspaceId, activity] of next) {
    if (previous.get(workspaceId) !== activity) {
      return false;
    }
  }
  return true;
}

function addDescendantActivity(
  agents: ReadonlyMap<string, Agent>,
  activityByWorkspaceId: Map<string, WorkspaceAgentActivity>,
  providerChildren: readonly ProviderSubagentDescriptorPayload[],
) {
  // Workspace activity includes descendants; individual thread state stays untouched.
  const propagate = (owner: Agent, status: WorkspaceDescriptor["status"]) => {
    const visited = new Set<string>();
    let current: Agent | undefined = owner;
    while (current && !current.archivedAt && !visited.has(current.id)) {
      visited.add(current.id);
      if (current.workspaceId) {
        const existing = activityByWorkspaceId.get(current.workspaceId);
        if (
          !existing ||
          aggregateSidebarStateBuckets([existing.status, status]) !== existing.status
        ) {
          activityByWorkspaceId.set(current.workspaceId, {
            agentId: owner.id,
            status,
            enteredAt: owner.attentionTimestamp ?? owner.updatedAt,
          });
        }
      }
      current = current.parentAgentId ? agents.get(current.parentAgentId) : undefined;
    }
  };
  for (const agent of agents.values()) {
    if (agent.archivedAt) continue;
    const status = deriveSidebarStateBucket({
      status: workspaceAgentStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    });
    if (status === "running" || status === "needs_input" || status === "failed")
      propagate(agent, status);
  }
  for (const child of providerChildren) {
    const owner = agents.get(child.parentAgentId);
    if (owner && (child.status === "running" || child.status === "failed"))
      propagate(owner, child.status === "running" ? "running" : "failed");
  }
}
