import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { summarizeWorkspaceRelations } from "./workspace-relations";
import { workspaceDisplayName } from "@/components/sidebar/sidebar-workspace-title";

const EMPTY_AGENTS = new Map<string, Agent>();

/** Role only: workspace execution status is derived by the sidebar activity index. */
export function useWorkspaceWorkerLabel({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.sessions[serverId]?.agents ?? EMPTY_AGENTS);
  const workspaces = useSessionStore((s) => s.sessions[serverId]?.workspaces);
  const relations = useMemo(
    () => summarizeWorkspaceRelations(workspaceId, agents, []),
    [workspaceId, agents],
  );
  if (relations.formerParentNames.length)
    return t("workspaceRelations.formerChild", {
      parent: relations.formerParentNames.map(workspaceDisplayName).join(" / "),
    });
  if (relations.parentWorkspaceIds.length)
    return t("workspaceRelations.worker", {
      parent: relations.parentWorkspaceIds
        .map((id) =>
          workspaceDisplayName(workspaces?.get(id)?.name ?? t("workspaceRelations.missingParent")),
        )
        .join(" / "),
    });
  return relations.missingParent ? t("workspaceRelations.missingParent") : null;
}
