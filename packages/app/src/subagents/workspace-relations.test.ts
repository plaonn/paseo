import { describe, expect, it } from "vitest";
import { summarizeWorkspaceRelations, type RelationAgent } from "./workspace-relations";

function agent(
  id: string,
  workspaceId: string,
  parentAgentId: string | null = null,
): RelationAgent {
  return {
    id,
    workspaceId,
    parentAgentId,
    status: "idle",
    archivedAt: null,
    pendingPermissions: [],
    labels: {},
    turn: { phase: "idle" },
  };
}

describe("workspace relationships", () => {
  it("keeps own completion separate from nested and cross-workspace activity", () => {
    const root = agent("root", "parent");
    const child = agent("child", "worker", "root");
    const nested = { ...agent("nested", "worker", "child"), turn: { phase: "open" as const } };
    const agents = new Map([root, child, nested].map((a) => [a.id, a]));
    expect(summarizeWorkspaceRelations("parent", agents, [])).toEqual({
      running: 1,
      total: 2,
      attention: 0,
      parentWorkspaceIds: [],
      missingParent: false,
      formerParentNames: [],
      providerParentIds: ["child", "nested", "root"],
    });
    expect(summarizeWorkspaceRelations("worker", agents, []).parentWorkspaceIds).toEqual([
      "parent",
    ]);
  });
  it("includes completed provider children and nests native children only once", () => {
    const root = agent("root", "parent");
    const local = agent("local", "parent", "root");
    const agents = new Map([root, local].map((a) => [a.id, a]));
    const provider = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      parentAgentId: "root",
      parentSubagentId: i ? "0" : null,
      provider: "codex" as const,
      title: null,
      description: null,
      status: "completed" as const,
      createdAt: "2026-09-21T00:00:00Z",
      updatedAt: "2026-09-21T00:00:00Z",
      toolCallId: null,
    }));
    expect(summarizeWorkspaceRelations("parent", agents, provider)).toMatchObject({
      total: 6,
      running: 0,
      attention: 0,
    });
  });
  it("never labels a mixed independent workspace worker-only", () => {
    const nodes = [
      agent("root", "parent"),
      agent("child", "worker", "root"),
      agent("user", "worker"),
    ];
    expect(
      summarizeWorkspaceRelations("worker", new Map(nodes.map((a) => [a.id, a])), [])
        .parentWorkspaceIds,
    ).toEqual([]);
  });
  it("keeps unresolved parents visible and excludes archived descendants", () => {
    const nodes = [
      agent("child", "worker", "missing"),
      { ...agent("old", "worker", "child"), archivedAt: new Date() },
    ];
    expect(
      summarizeWorkspaceRelations("worker", new Map(nodes.map((a) => [a.id, a])), []),
    ).toMatchObject({ missingParent: true, total: 0 });
  });
  it("keeps archived-parent provenance display-only and respects authoritative idle turns", () => {
    const child = {
      ...agent("child", "worker"),
      labels: {
        "paseo.archived-parent-workspace-id": "old",
        "paseo.archived-parent-workspace-name": "Old parent",
      },
    };
    const nested = { ...agent("nested", "worker", "child"), status: "running" as const };
    const summary = summarizeWorkspaceRelations(
      "worker",
      new Map([child, nested].map((a) => [a.id, a])),
      [],
    );
    expect(summary).toMatchObject({
      formerParentNames: ["Old parent"],
      parentWorkspaceIds: [],
      running: 0,
      total: 1,
    });
  });
});
