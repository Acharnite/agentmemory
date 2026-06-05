import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import type {
  CompressedObservation,
  GraphNode,
} from "../src/types.js";
import { jaccardSimilarity } from "../src/state/schema.js";

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
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id =
        typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
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

const testObs1: CompressedObservation = {
  id: "obs_dedup_1",
  sessionId: "ses_dedup",
  timestamp: "2026-03-01T10:00:00Z",
  type: "file_edit",
  title: "Edit 1",
  facts: ["Fact 1"],
  narrative: "Narrative 1",
  concepts: ["concept-a"],
  files: ["a.ts"],
  importance: 5,
};

const testObs2: CompressedObservation = {
  id: "obs_dedup_2",
  sessionId: "ses_dedup",
  timestamp: "2026-03-01T11:00:00Z",
  type: "file_edit",
  title: "Edit 2",
  facts: ["Fact 2"],
  narrative: "Narrative 2",
  concepts: ["concept-b"],
  files: ["b.ts"],
  importance: 5,
};

describe("Jaccard dedup in graph extraction (Fix 2)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  it("1. exact name match still works (name index hit, no fuzzy scan)", async () => {
    // First extract creates a node.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="MyFeature"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    // Second extract with identical name hits name-index => no fuzzy scan.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="MyFeature"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(1);
    expect(nodes[0].name).toBe("MyFeature");
  });

  it("2. Jaccard dedup merges nodes with similar names (Jaccard > 0.8)", async () => {
    // "AgentMemory" and "agentmemory" produce the same word-token after
    // lowercasing (both -> {"agentmemory"}) so Jaccard = 1.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="AgentMemory"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="agentmemory"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(1);

    // Vanity check: confirm the Jaccard value is indeed > 0.8.
    const sim = jaccardSimilarity("AgentMemory".toLowerCase(), "agentmemory".toLowerCase());
    expect(sim).toBeGreaterThan(0.8);
  });

  it("3. Jaccard dedup does NOT merge nodes with different names (Jaccard < 0.8)", async () => {
    // "agentmemory" -> {"agentmemory"}
    // "knowledge base" -> {"knowledge", "base"}
    // No tokens in common => Jaccard = 0.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="agentmemory"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="knowledge base"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);

    const sim = jaccardSimilarity("agentmemory", "knowledge base");
    expect(sim).toBeLessThan(0.8);
  });

  it("4. short names (< 3 chars) are excluded from Jaccard scan", async () => {
    // "ab" has length 2 < 3 => Jaccard scan skipped entirely.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="ab"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    // Even though "ab" == "ab" after lowercasing, Jaccard scan is
    // skipped due to short name, so a second identical short name
    // creates a duplicate via a different generated ID.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="ab"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    // Name-index exact match DOES still apply (name is the same,
    // so nameIndexKey is identical) => deduped to 1.
    // NOTE: exact match runs BEFORE the Jaccard scan. Since the name
    // is identical the name index hit merges them regardless of length.
    // The "short name exclusion" only matters for non-identical names.
    // Verify: the exact-match name-index works for short names too.
    expect(nodes.length).toBe(1);
  });

  it("4b. short names with different casing skip Jaccard scan when exact match misses", async () => {
    // "Ab" (exact match key "concept|Ab") and "ab" (key "concept|ab")
    // have different name-index keys. The Jaccard scan is skipped
    // because "ab".length < 3, so they land as TWO separate nodes.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="Ab"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="ab"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);
  });

  it("5. same name, different type => NOT merged (Jaccard respects type match)", async () => {
    // First extract creates a function node named "main".
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="function" name="main"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    // Second extract creates a concept node also named "main".
    // Type differs => Jaccard scan filter `n.type === node.type` fails.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="main"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(2);
    expect(nodes.filter((n) => n.type === "function").length).toBe(1);
    expect(nodes.filter((n) => n.type === "concept").length).toBe(1);
  });

  it("6. merged node has combined sourceObservationIds", async () => {
    // Extract "AgentMemory" with obs_1, then "agentmemory" with obs_2.
    // The merged node should carry both sourceObservationIds.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="AgentMemory"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs1] });

    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="concept" name="agentmemory"/>
</entities>`);
    await sdk.trigger("mem::graph-extract", { observations: [testObs2] });

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(1);
    const merged = nodes[0];

    // Both observation IDs present in sourceObservationIds.
    expect(merged.sourceObservationIds).toContain("obs_dedup_1");
    expect(merged.sourceObservationIds).toContain("obs_dedup_2");
  });
});
