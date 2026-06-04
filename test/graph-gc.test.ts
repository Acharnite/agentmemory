import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock recordAudit so graph-gc doesn't actually write audit entries
vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import { KV } from "../src/state/schema.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    // Expose store for test assertions only
    _store: store,
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (
      idOrOpts: string | { id: string },
      handler: Function,
    ) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (
      idOrInput:
        | string
        | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string"
          ? idOrInput
          : idOrInput.function_id;
      const payload =
        typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const mockProvider = {
  name: "test",
  compress: vi.fn(),
  summarize: vi.fn(),
};

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Helper to create a graph node
function makeNode(
  overrides: Partial<{
    id: string;
    type: string;
    name: string;
    stale: boolean;
    sourceObservationIds: string[];
    createdAt: string;
  }>,
) {
  return {
    id: overrides.id ?? "node_default",
    type: overrides.type ?? "file",
    name: overrides.name ?? "test.ts",
    stale: overrides.stale ?? false,
    sourceObservationIds: overrides.sourceObservationIds ?? [],
    createdAt: overrides.createdAt ?? daysAgo(1),
    properties: {},
    updatedAt: daysAgo(1),
  };
}

// Helper to create a graph edge
function makeEdge(
  overrides: Partial<{
    id: string;
    type: string;
    sourceNodeId: string;
    targetNodeId: string;
    stale: boolean;
    weight: number;
    sourceObservationIds: string[];
    createdAt: string;
  }>,
) {
  return {
    id: overrides.id ?? "edge_default",
    type: overrides.type ?? "imports",
    sourceNodeId: overrides.sourceNodeId ?? "node_a",
    targetNodeId: overrides.targetNodeId ?? "node_b",
    stale: overrides.stale ?? false,
    weight: overrides.weight ?? 0.5,
    sourceObservationIds: overrides.sourceObservationIds ?? ["obs_1"],
    createdAt: overrides.createdAt ?? daysAgo(1),
  };
}

describe("mem::graph-gc", () => {
  async function setupAndRunGc(kv: ReturnType<typeof mockKV>) {
    const sdk = mockSdk();
    registerGraphFunction(sdk as never, kv as never, mockProvider);
    const result = await sdk.trigger({
      function_id: "mem::graph-gc",
      payload: {},
    });
    return result as { success: boolean; stats: Record<string, number> };
  }

  describe("stale node deletion", () => {
    it("deletes stale nodes", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_stale", makeNode({ id: "node_stale", stale: true }));
      await kv.set(KV.graphNodes, "node_fresh", makeNode({ id: "node_fresh" }));

      const result = await setupAndRunGc(kv);

      expect(result.success).toBe(true);
      expect(result.stats.staleNodes).toBe(1);
      const remaining = await kv.list(KV.graphNodes);
      expect(remaining.map((n: any) => n.id)).toEqual(["node_fresh"]);
    });

    it("handles no stale nodes gracefully", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));

      const result = await setupAndRunGc(kv);
      expect(result.stats.staleNodes).toBe(0);
    });
  });

  describe("stale edge deletion", () => {
    it("deletes stale edges", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));
      await kv.set(KV.graphNodes, "node_b", makeNode({ id: "node_b" }));
      await kv.set(
        KV.graphEdges,
        "edge_stale",
        makeEdge({ id: "edge_stale", stale: true }),
      );
      await kv.set(
        KV.graphEdges,
        "edge_fresh",
        makeEdge({ id: "edge_fresh" }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.staleEdges).toBe(1);
      const remaining = await kv.list(KV.graphEdges);
      expect(remaining.map((e: any) => e.id)).toEqual(["edge_fresh"]);
    });
  });

  describe("isolated node deletion", () => {
    it("deletes isolated old nodes (no edges, no observations)", async () => {
      const kv = mockKV();
      // 10 days old, no edges, no observations -> should be GC'd
      await kv.set(
        KV.graphNodes,
        "node_isolated",
        makeNode({
          id: "node_isolated",
          createdAt: daysAgo(10),
          sourceObservationIds: [],
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.isolatedNodes).toBe(1);
      const remaining = await kv.list(KV.graphNodes);
      expect(remaining).toHaveLength(0);
    });

    it("keeps nodes that have incident edges", async () => {
      const kv = mockKV();
      await kv.set(
        KV.graphNodes,
        "node_with_edge",
        makeNode({
          id: "node_with_edge",
          createdAt: daysAgo(10),
          sourceObservationIds: [],
        }),
      );
      // An edge references this node
      await kv.set(
        KV.graphEdges,
        "edge_keep",
        makeEdge({
          id: "edge_keep",
          sourceNodeId: "node_with_edge",
          targetNodeId: "node_other",
        }),
      );

      // But node_other is added too (referenced by edge), so it's also kept
      await kv.set(
        KV.graphNodes,
        "node_other",
        makeNode({ id: "node_other" }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.isolatedNodes).toBe(0);
      const remaining = await kv.list(KV.graphNodes);
      expect(remaining).toHaveLength(2);
    });

    it("keeps nodes that have observations even without edges", async () => {
      const kv = mockKV();
      await kv.set(
        KV.graphNodes,
        "node_with_obs",
        makeNode({
          id: "node_with_obs",
          createdAt: daysAgo(10),
          sourceObservationIds: ["obs_1"],
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.isolatedNodes).toBe(0);
      const remaining = await kv.list(KV.graphNodes);
      expect(remaining).toHaveLength(1);
    });

    it("keeps fresh isolated nodes (less than 7 days old)", async () => {
      const kv = mockKV();
      await kv.set(
        KV.graphNodes,
        "node_fresh_iso",
        makeNode({
          id: "node_fresh_iso",
          createdAt: daysAgo(1),
          sourceObservationIds: [],
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.isolatedNodes).toBe(0);
      const remaining = await kv.list(KV.graphNodes);
      expect(remaining).toHaveLength(1);
    });

    it("does not count stale nodes as isolated (already counted as staleNodes)", async () => {
      const kv = mockKV();
      // Stale AND isolated — should be counted as stale only
      await kv.set(
        KV.graphNodes,
        "node_stale_isolated",
        makeNode({
          id: "node_stale_isolated",
          stale: true,
          createdAt: daysAgo(10),
          sourceObservationIds: [],
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.staleNodes).toBe(1);
      expect(result.stats.isolatedNodes).toBe(0);
    });
  });

  describe("redundant related_to edge dedup", () => {
    it("deletes related_to edges when a stronger edge type exists between same nodes", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));
      await kv.set(KV.graphNodes, "node_b", makeNode({ id: "node_b" }));

      // Stronger edge (not related_to) between same pair
      await kv.set(
        KV.graphEdges,
        "edge_imports",
        makeEdge({
          id: "edge_imports",
          type: "imports",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );
      // Redundant related_to edge between same pair
      await kv.set(
        KV.graphEdges,
        "edge_redundant",
        makeEdge({
          id: "edge_redundant",
          type: "related_to",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.redundantRelatedTo).toBe(1);
      const remaining = await kv.list(KV.graphEdges);
      expect(remaining.map((e: any) => e.id)).toEqual(["edge_imports"]);
    });

    it("keeps related_to when it is the only edge type between nodes", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));
      await kv.set(KV.graphNodes, "node_b", makeNode({ id: "node_b" }));

      await kv.set(
        KV.graphEdges,
        "edge_only_related",
        makeEdge({
          id: "edge_only_related",
          type: "related_to",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.redundantRelatedTo).toBe(0);
      const remaining = await kv.list(KV.graphEdges);
      expect(remaining).toHaveLength(1);
    });

    it("handles multiple redundant related_to edges between same nodes", async () => {
      const kv = mockKV();
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));
      await kv.set(KV.graphNodes, "node_b", makeNode({ id: "node_b" }));

      await kv.set(
        KV.graphEdges,
        "edge_uses",
        makeEdge({
          id: "edge_uses",
          type: "uses",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );
      await kv.set(
        KV.graphEdges,
        "edge_rel_1",
        makeEdge({
          id: "edge_rel_1",
          type: "related_to",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );
      await kv.set(
        KV.graphEdges,
        "edge_rel_2",
        makeEdge({
          id: "edge_rel_2",
          type: "related_to",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats.redundantRelatedTo).toBe(2);
      const remaining = await kv.list(KV.graphEdges);
      expect(remaining.map((e: any) => e.id)).toEqual(["edge_uses"]);
    });
  });

  describe("combined GC run", () => {
    it("handles an empty graph gracefully", async () => {
      const result = await setupAndRunGc(mockKV());

      expect(result.success).toBe(true);
      expect(result.stats).toEqual({
        staleNodes: 0,
        staleEdges: 0,
        isolatedNodes: 0,
        redundantRelatedTo: 0,
      });
    });

    it("returns stats for mixed graph state", async () => {
      const kv = mockKV();

      // Stale node
      await kv.set(
        KV.graphNodes,
        "node_stale",
        makeNode({ id: "node_stale", stale: true }),
      );
      // Fresh node that will be referenced by edge
      await kv.set(KV.graphNodes, "node_a", makeNode({ id: "node_a" }));
      await kv.set(KV.graphNodes, "node_b", makeNode({ id: "node_b" }));
      // Isolated old node
      await kv.set(
        KV.graphNodes,
        "node_isolated",
        makeNode({
          id: "node_isolated",
          createdAt: daysAgo(10),
          sourceObservationIds: [],
        }),
      );

      // Stale edge
      await kv.set(
        KV.graphEdges,
        "edge_stale",
        makeEdge({ id: "edge_stale", stale: true }),
      );
      // Stronger edge between node_a/node_b
      await kv.set(
        KV.graphEdges,
        "edge_uses",
        makeEdge({
          id: "edge_uses",
          type: "uses",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );
      // Redundant related_to
      await kv.set(
        KV.graphEdges,
        "edge_redundant",
        makeEdge({
          id: "edge_redundant",
          type: "related_to",
          sourceNodeId: "node_a",
          targetNodeId: "node_b",
        }),
      );

      const result = await setupAndRunGc(kv);

      expect(result.stats).toEqual({
        staleNodes: 1,
        staleEdges: 1,
        isolatedNodes: 1,
        redundantRelatedTo: 1,
      });

      const nodes = await kv.list(KV.graphNodes);
      expect(nodes.map((n: any) => n.id).sort()).toEqual([
        "node_a",
        "node_b",
      ]);

      const edges = await kv.list(KV.graphEdges);
      expect(edges.map((e: any) => e.id)).toEqual(["edge_uses"]);
    });
  });
});
