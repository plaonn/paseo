import { z } from "zod";
export interface CleanupWorkspace {
  id: string;
  workspaceDirectory: string;
  pinnedAt: string | null;
  archivingAt?: string | null;
}
export interface CleanupActions {
  terminals(workspaceId: string): Promise<boolean>;
  archive(workspaceId: string): Promise<void>;
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
export interface Agent {
  id: string;
  workspaceId?: string;
  status: string;
  parent?: string;
  permissions: number;
  archived?: boolean;
  lastUserMessageAt?: string | null;
}
export function descendants(seeds: string[], agents: Agent[]): Agent[] {
  const ids = new Set(seeds),
    result: Agent[] = [];
  for (let i = 0; i < agents.length; i++) {
    const added = agents.filter((a) => !ids.has(a.id) && a.parent && ids.has(a.parent));
    if (!added.length) break;
    for (const a of added) {
      ids.add(a.id);
      result.push(a);
    }
  }
  return result;
}
const exec = promisify(execFile);
export interface Operation {
  state: "starting" | "unknown" | "archived" | "retained";
  reason?: string;
}
export interface Binding {
  workspaceId: string;
  parent: string;
  lastUserMessageAt: string | null;
}
export interface Sweep {
  root: string;
  observedAt: string;
  agentIds?: string[];
  subtreeIds?: string[];
  bindings?: Record<string, Binding>;
  capturedAt?: string;
  confirmed?: boolean;
  operations: Record<string, Operation>;
}
export type Journal = Record<string, Sweep>;
const workspaceId = z.string().regex(/^wks_[a-zA-Z0-9]+$/);
const agentId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const agentIdsSchema = z
  .array(agentId)
  .max(20000)
  .refine((value) => new Set(value).size === value.length);
const sweepSchema = z
  .object({
    root: workspaceId,
    observedAt: timestamp,
    agentIds: agentIdsSchema.optional(),
    subtreeIds: agentIdsSchema.optional(),
    capturedAt: timestamp.optional(),
    confirmed: z.boolean().optional(),
    bindings: z
      .record(
        agentId,
        z
          .object({ workspaceId, parent: agentId, lastUserMessageAt: timestamp.nullable() })
          .strict(),
      )
      .optional(),
    operations: z.record(
      workspaceId,
      z
        .object({
          state: z.enum(["starting", "unknown", "archived", "retained"]),
          reason: z.string().max(200).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export function validJournal(value: unknown): Journal {
  const parsed = z.record(workspaceId, sweepSchema).parse(value);
  if (Object.keys(parsed).length > 1000) throw Error("invalid archive journal");
  for (const [key, s] of Object.entries(parsed)) {
    if (key !== s.root || Object.keys(s.operations).length > 1000 || key in s.operations)
      throw Error("invalid archive sweep");
    validateScope(s);
  }
  return parsed;
}
function validateScope(s: Sweep) {
  if (s.agentIds !== undefined || s.subtreeIds !== undefined || Object.keys(s.operations).length) {
    if (!s.agentIds?.length || !s.subtreeIds || s.agentIds.some((id) => s.subtreeIds?.includes(id)))
      throw Error("invalid archive scope");
  }
  if (s.bindings !== undefined || s.capturedAt !== undefined) {
    if (
      !s.bindings ||
      !s.capturedAt ||
      !s.subtreeIds ||
      Object.keys(s.bindings).length !== s.subtreeIds.length ||
      Object.keys(s.bindings).some((id) => !s.subtreeIds?.includes(id))
    )
      throw Error("invalid native capture");
  }
}
// Captured only on a native archive transition, before Paseo detaches
// cross-workspace children. No manually assigned owner or guessed relationship.
export function captureScope(root: string, agents: Agent[], capturedAt: string): Sweep | null {
  const roots = agents.filter((a) => a.workspaceId === root && !a.parent).map((a) => a.id);
  if (!roots.length) return null;
  const children = descendants(roots, agents);
  if (children.some((a) => !a.workspaceId || !a.parent)) return null;
  return {
    root,
    observedAt: new Date().toISOString(),
    capturedAt,
    confirmed: false,
    agentIds: roots,
    subtreeIds: children.map((a) => a.id),
    bindings: Object.fromEntries(
      children.map((a) => [
        a.id,
        {
          workspaceId: a.workspaceId!,
          parent: a.parent!,
          lastUserMessageAt: a.lastUserMessageAt || null,
        },
      ]),
    ),
    operations: {},
  };
}
export function capturedGraph(sweep: Sweep, agents: Agent[]): Agent[] {
  if (!sweep.bindings || sweep.confirmed !== true) return agents;
  return agents.map((a) => {
    const b = sweep.bindings![a.id];
    if (!b) return a;
    if (
      a.workspaceId !== b.workspaceId ||
      (a.lastUserMessageAt || null) !== b.lastUserMessageAt ||
      (a.parent && a.parent !== b.parent)
    )
      return { ...a, parent: undefined };
    if (!a.parent && agents.some((p) => p.id === b.parent && p.archived))
      return { ...a, parent: b.parent };
    return a;
  });
}
export function candidates(sweep: Sweep, agents: Agent[]) {
  agents = capturedGraph(sweep, agents);
  const roots =
    sweep.agentIds ||
    agents.filter((a) => a.workspaceId === sweep.root && !a.parent).map((a) => a.id);
  if (
    !roots.every((id) =>
      agents.some(
        (a) =>
          a.id === id &&
          a.workspaceId === sweep.root &&
          !a.parent &&
          (!sweep.bindings || a.archived),
      ),
    )
  )
    return [];
  const children = descendants(roots, agents).filter(
    (a) => !sweep.subtreeIds || sweep.subtreeIds.includes(a.id),
  );
  const ids = new Set(children.map((a) => a.id));
  return [
    ...new Set(
      children.map((a) => a.workspaceId).filter((id): id is string => !!id && id !== sweep.root),
    ),
  ].filter((id) => agents.filter((a) => a.workspaceId === id).every((a) => ids.has(a.id)));
}
export async function preservedGit(directory: string): Promise<string | null> {
  async function git(args: string[]) {
    return (
      await exec("git", ["-C", directory, ...args], {
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout.trim();
  }
  try {
    if (
      (await realpath(await git(["rev-parse", "--show-toplevel"]))) !== (await realpath(directory))
    )
      return "not-git-root";
    // Include ignored files: automatic deletion must not discard private ignored artifacts.
    if (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]))
      return "unpreserved-files";
    const head = await git(["rev-parse", "HEAD"]);
    if (
      !(await git(["for-each-ref", `--contains=${head}`, "--format=%(refname)", "refs/remotes/"]))
    )
      return "commit-not-preserved-on-remote-ref";
    return null;
  } catch {
    return "git-preservation-unverified";
  }
}
export async function sharedDirectory(
  current: CleanupWorkspace,
  workspaces: CleanupWorkspace[],
): Promise<boolean> {
  const target = await realpath(current.workspaceDirectory!);
  for (const w of workspaces) {
    if (w.id === current.id || !w.workspaceDirectory) continue;
    try {
      if ((await realpath(w.workspaceDirectory)) === target) return true;
    } catch {
      return true;
    } // Cannot prove that a missing/inaccessible reference is distinct.
  }
  return false;
}
export interface CleanupDependencies {
  agents(): Promise<Agent[]>;
  workspaces(): Promise<CleanupWorkspace[]>;
  save(): Promise<void>;
  providerBusy(workspaceId: string, agents: Agent[]): Promise<boolean>;
  cancelled?(): boolean;
  shared?(current: CleanupWorkspace, all: CleanupWorkspace[]): Promise<boolean>;
  preserved?(directory: string): Promise<string | null>;
}

async function retainReason(
  api: CleanupActions,
  deps: CleanupDependencies,
  sweep: Sweep,
  current: CleanupWorkspace,
): Promise<string | null> {
  const agents = await deps.agents();
  const workspaces = await deps.workspaces();
  const fresh = workspaces.find((w) => w.id === current.id);
  if (
    workspaces.some((w) => w.id === sweep.root) ||
    !fresh ||
    fresh.workspaceDirectory !== current.workspaceDirectory
  )
    return "prewrite-state-changed";
  if (!candidates(sweep, agents).includes(current.id)) return "ownership-changed";
  if (
    agents.some(
      (a) =>
        a.workspaceId === current.id &&
        !a.archived &&
        (a.permissions > 0 || !["idle", "closed"].includes(a.status)),
    )
  )
    return "active-or-attention-agent";
  if (await deps.providerBusy(current.id, agents)) return "active-or-attention-provider-subagent";
  if (fresh.pinnedAt || fresh.archivingAt) return "pinned-or-archiving";
  if (!fresh.workspaceDirectory) return "directory-unavailable";
  if (await api.terminals(current.id)) return "terminal-present";
  if (await (deps.shared ?? sharedDirectory)(fresh, workspaces)) return "shared-directory";
  return (deps.preserved ?? preservedGit)(fresh.workspaceDirectory);
}

async function collectCandidate(
  api: CleanupActions,
  journal: Journal,
  deps: CleanupDependencies,
  sweep: Sweep,
  id: string,
) {
  const previous = sweep.operations[id];
  if (previous?.state === "archived") return;
  const current = (await deps.workspaces()).find((w) => w.id === id);
  if (!current) {
    if (previous) {
      sweep.operations[id] = { state: "archived", reason: "absent-on-complete-directory-read" };
      await deps.save();
    }
    return;
  }
  if (previous?.state === "starting" || previous?.state === "unknown") return;
  let reason = Object.values(journal).some(
    (other) =>
      other !== sweep && ["starting", "unknown", "archived"].includes(other.operations[id]?.state),
  )
    ? "other-sweep-operation"
    : await retainReason(api, deps, sweep, current);
  // Re-read after asynchronous Git checks; never act on a stale ownership/activity snapshot.
  if (!reason) reason = await retainReason(api, deps, sweep, current);
  if (reason) {
    sweep.operations[id] = { state: "retained", reason };
    await deps.save();
    return;
  }
  if (deps.cancelled?.()) return;
  sweep.operations[id] = { state: "starting" };
  await deps.save();
  if (deps.cancelled?.()) {
    sweep.operations[id] = { state: "retained", reason: "service-stopped-before-call" };
    await deps.save();
    return;
  }
  try {
    await api.archive(id);
  } catch {
    /* Exact readback, never blind retry. */
  }
  const remains = (await deps.workspaces()).some((w) => w.id === id);
  sweep.operations[id] = remains
    ? { state: "unknown", reason: "archive-not-confirmed" }
    : { state: "archived" };
  await deps.save();
}

export async function sweepArchives(
  api: CleanupActions,
  journal: Journal,
  deps: CleanupDependencies,
) {
  for (const sweep of Object.values(journal)) {
    if (deps.cancelled?.()) return;
    // Legacy entries without a pre-detachment capture remain retained on migration.
    if (!sweep.bindings || sweep.confirmed !== true || !sweep.agentIds) continue;
    const agents = await deps.agents();
    if ((await deps.workspaces()).some((w) => w.id === sweep.root)) continue;
    for (const id of new Set([...candidates(sweep, agents), ...Object.keys(sweep.operations)])) {
      await collectCandidate(api, journal, deps, sweep, id);
    }
  }
}
