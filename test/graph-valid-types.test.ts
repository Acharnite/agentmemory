import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerGraphFunction } from "../src/functions/graph.js";
import type { CompressedObservation, GraphNode } from "../src/types.js";

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

const testObs: CompressedObservation = {
  id: "obs_vt_1",
  sessionId: "ses_vt",
  timestamp: "2026-04-01T10:00:00Z",
  type: "file_edit",
  title: "Valid types test",
  facts: ["Test"],
  narrative: "Testing VALID_TYPES guard",
  concepts: ["testing"],
  files: ["test.ts"],
  importance: 3,
};

describe("parseGraphXml — VALID_TYPES guard (Fix 4)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    vi.clearAllMocks();
    registerGraphFunction(sdk as never, kv as never, mockProvider as never);
  });

  const VALID_TYPES = [
    "file",
    "function",
    "concept",
    "error",
    "decision",
    "pattern",
    "library",
    "person",
  ];

  for (const validType of VALID_TYPES) {
    it(`1. accepts valid type "${validType}"`, async () => {
      mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="${validType}" name="test-entity"/>
</entities>`);
      const result = (await sdk.trigger("mem::graph-extract", {
        observations: [testObs],
      })) as { success: boolean; nodesAdded: number };

      expect(result.success).toBe(true);
      expect(result.nodesAdded).toBe(1);

      const nodes = await kv.list<GraphNode>("mem:graph:nodes");
      expect(nodes.length).toBe(1);
      expect(nodes[0].type).toBe(validType);
    });
  }

  it("2a. rejects invalid type string", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="invalid_type" name="whatever"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(0);
  });

  it("2b. rejects pipe-concatenated type string", async () => {
    // LLMs sometimes emit the entire type list when confused.
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file|function|concept" name="oops"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });

  it("2c. rejects empty type string", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="" name="empty-type"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });

  it("3a. missing type attribute returns early (no crash, no node)", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity name="no-type"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });

  it("3b. missing name attribute returns early (no crash, no node)", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });

  it("4. mixed valid+invalid entities: valid ones pass, invalid are skipped", async () => {
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file" name="src/index.ts"/>
<entity type="invalid_type" name="bad-one"/>
<entity type="function" name="main"/>
<entity type="concept" name="MyConcept"/>
<entity type="bogus" name="also-bad"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(3);

    const nodes = await kv.list<GraphNode>("mem:graph:nodes");
    expect(nodes.length).toBe(3);
    expect(nodes.find((n) => n.name === "src/index.ts")).toBeDefined();
    expect(nodes.find((n) => n.name === "main")).toBeDefined();
    expect(nodes.find((n) => n.name === "MyConcept")).toBeDefined();
    expect(nodes.find((n) => n.name === "bad-one")).toBeUndefined();
    expect(nodes.find((n) => n.name === "also-bad")).toBeUndefined();
  });

  it("5a. type with trailing whitespace is rejected", async () => {
    // The VALID_TYPES set contains exact strings — "file " != "file".
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="file " name="src/index.ts"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });

  it("5b. mixed-case type is rejected", async () => {
    // VALID_TYPES is lowercase-only — "File" !== "file".
    mockProvider.compress.mockResolvedValueOnce(`<entities>
<entity type="File" name="src/index.ts"/>
</entities>`);
    const result = (await sdk.trigger("mem::graph-extract", {
      observations: [testObs],
    })) as { success: boolean; nodesAdded: number };

    expect(result.success).toBe(true);
    expect(result.nodesAdded).toBe(0);
  });
});
