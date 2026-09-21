import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { refreshProviderSubagents, useProviderSubagentStore } from "./provider-store";
import { summarizeWorkspaceRelations } from "./workspace-relations";

const EMPTY_AGENTS = new Map<string, Agent>();

export function useWorkspaceRelationsLabel({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const { t } = useTranslation();
  const agents = useSessionStore((s) => s.sessions[serverId]?.agents ?? EMPTY_AGENTS);
  const workspaces = useSessionStore((s) => s.sessions[serverId]?.workspaces);
  const client = useSessionStore((s) => s.sessions[serverId]?.client);
  const supported = useSessionStore(
    (s) => s.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const descriptors = useProviderSubagentStore((s) => s.descriptors);
  const relations = useMemo(
    () =>
      summarizeWorkspaceRelations(
        workspaceId,
        agents,
        [...descriptors.entries()]
          .filter(([key]) => key.startsWith(`${serverId}\0`))
          .map(([, value]) => value),
      ),
    [workspaceId, agents, descriptors, serverId],
  );
  const parentIds = JSON.stringify(relations.providerParentIds);
  const [providerRead, setProviderRead] = useState<{ key: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!client || !supported) return;
    let cancelled = false;
    setProviderRead(null);
    const ids: string[] = JSON.parse(parentIds);
    void Promise.all(ids.map((id) => refreshProviderSubagents(client, serverId, id))).then(
      () => {
        if (!cancelled) setProviderRead({ key: parentIds, error: false });
        return undefined;
      },
      () => {
        if (!cancelled) setProviderRead({ key: parentIds, error: true });
        return undefined;
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, supported, parentIds, serverId]);
  const pieces: string[] = [];
  if (relations.formerParentNames.length)
    pieces.push(
      t("workspaceRelations.formerChild", { parent: relations.formerParentNames.join(" / ") }),
    );
  if (relations.parentWorkspaceIds.length) {
    const parents = relations.parentWorkspaceIds.map(
      (id) => workspaces?.get(id)?.name ?? t("workspaceRelations.missingParent"),
    );
    pieces.push(t("workspaceRelations.worker", { parent: parents.join(" / ") }));
  } else if (relations.missingParent) pieces.push(t("workspaceRelations.missingParent"));
  if (relations.total && (!supported || (providerRead?.key === parentIds && !providerRead.error)))
    pieces.push(
      t("workspaceRelations.children", { running: relations.running, total: relations.total }),
    );
  if (relations.attention)
    pieces.push(t("workspaceRelations.attention", { count: relations.attention }));
  if (
    supported &&
    relations.providerParentIds.length > 0 &&
    (providerRead?.key !== parentIds || providerRead.error)
  )
    pieces.push(t("workspaceRelations.unavailable"));
  if (!pieces.length) return null;
  return pieces.join(" · ");
}
