import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/config.js", () => ({
  isGraphExtractionEnabled: () => true,
}));

vi.mock("../src/functions/slots.js", () => ({
  isReflectEnabled: () => false,
}));

vi.mock("iii-sdk", () => ({
  TriggerAction: { Void: () => ({}) },
}));

import { registerEventTriggers } from "../src/triggers/events.js";
import { KV } from "../src/state/schema.js";
import type { CompressedObservation } from "../src/types.js";

type Handler = (payload: unknown) => unknown | Promise<unknown>;

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
    update: async <T>(
      scope: string,
      key: string,
      _ops: unknown[],
    ): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  const calls: Array<{ function_id: string; payload: unknown }> = [];
  return {
    calls,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      registerTrigger: vi.fn(),
      trigger: async (input: {
        function_id: string;
        payload: unknown;
        action?: unknown;
      }) => {
        calls.push({
          function_id: input.function_id,
          payload: input.payload,
        });
        const handler = handlers.get(input.function_id);
        if (!handler)
          throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

function seedObservation(
  kv: ReturnType<typeof mockKV>,
  sessionId: string,
  obsId: string,
): void {
  const obs: CompressedObservation = {
    id: obsId,
    sessionId,
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Test observation",
    facts: ["test"],
    narrative: "Test narrative",
    concepts: ["test"],
    files: ["test.ts"],
    importance: 5,
  };
  kv.set(KV.observations(sessionId), obsId, obs);
}

describe("Extraction locking in events.ts (Fix 6)", () => {
  let sdk: ReturnType<typeof mockSdk>["sdk"];
  let calls: Array<{ function_id: string; payload: unknown }>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    const mock = mockSdk();
    sdk = mock.sdk;
    calls = mock.calls;
    kv = mockKV();

    // Register the event handlers.
    registerEventTriggers(sdk as never, kv as never);

    // Pre-register handlers that event::session::stopped calls.
    sdk.registerFunction("mem::summarize", async () => ({
      summary: "test summary",
    }));
    sdk.registerFunction("mem::graph-extract", async () => ({
      success: true,
      nodesAdded: 0,
      edgesAdded: 0,
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. first extraction for a session proceeds", async () => {
    seedObservation(kv, "ses_1", "obs_1");

    const result = (await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_1" },
    })) as { summary: string };

    // The handler returns the summary from mem::summarize.
    expect(result.summary).toBe("test summary");

    // mem::graph-extract should have been triggered.
    const graphCalls = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls.length).toBe(1);
    expect(graphCalls[0].payload).toEqual({
      observations: [expect.objectContaining({ id: "obs_1" })],
    });
  });

  it("2. concurrent extraction for the same session is skipped", async () => {
    seedObservation(kv, "ses_1", "obs_1");

    // Replace kv.list with a version that blocks on first call.
    // This lets us interleave two handler invocations so the second
    // arrives while the first holds the lock.
    let listResolve: () => void;
    const listBlocked = new Promise<void>((resolve) => {
      listResolve = resolve;
    });
    let listCalls = 0;
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      listCalls++;
      if (listCalls === 1) {
        // Block the first call's list — the handler has the lock here.
        await listBlocked;
      }
      return originalList.call(kv, scope) as Promise<T[]>;
    };

    // Start first call — it will run synchronously past the lock
    // acquisition and then block on kv.list.
    const p1 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_1" },
    });

    // Yield to the event loop so the handler can reach kv.list
    // (it awaits mem::summarize which resolves in a microtask).
    await new Promise((r) => setTimeout(r, 5));
    expect(listCalls).toBe(1); // first call reached kv.list

    // Second call should return immediately (lock held by first).
    const r2 = (await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_1" },
    })) as { summary: string };
    expect(r2.summary).toBe("test summary");

    // No graph-extract yet — first call is still blocked.
    let graphCalls = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls.length).toBe(0);

    // Unblock the first call so it can complete.
    listResolve!();
    const r1 = (await p1) as { summary: string };
    expect(r1.summary).toBe("test summary");

    // Now graph-extract should have been called exactly once.
    graphCalls = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls.length).toBe(1);
  });

  it("3. after extraction completes, the lock is released (next extraction proceeds)", async () => {
    seedObservation(kv, "ses_1", "obs_1");

    // First call: acquires lock, extracts, releases.
    await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_1" },
    });

    // Second call: lock is free, should extract again.
    await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_1" },
    });

    const graphCalls = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls.length).toBe(2);
  });

  it("4. concurrent extractions for DIFFERENT sessions both proceed", async () => {
    seedObservation(kv, "ses_a", "obs_a");
    seedObservation(kv, "ses_b", "obs_b");

    // Block kv.list so we can verify both calls proceed past the lock.
    let listResolve: () => void;
    const listBlocked = new Promise<void>((resolve) => {
      listResolve = resolve;
    });
    let listCalls = 0;
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      listCalls++;
      if (listCalls <= 2) {
        // Block the list for both sessions (both should have acquired
        // their respective locks since the lock key includes sessionId).
        await listBlocked;
      }
      return originalList.call(kv, scope) as Promise<T[]>;
    };

    // Fire both calls. Since lock keys differ (ses_a vs ses_b), both
    // should acquire their locks and proceed to kv.list.
    const p1 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_a" },
    });
    const p2 = sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_b" },
    });

    // Yield so both handlers can reach kv.list.
    await new Promise((r) => setTimeout(r, 5));
    expect(listCalls).toBe(2); // both reached kv.list

    // Unblock both.
    listResolve!();
    const [r1, r2] = (await Promise.all([p1, p2])) as [
      { summary: string },
      { summary: string },
    ];
    expect(r1.summary).toBe("test summary");
    expect(r2.summary).toBe("test summary");

    // Both should have triggered graph-extract (different locks).
    const graphCalls = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls.length).toBe(2);
  });

  it("5. error during extraction still releases the lock (try/finally)", async () => {
    seedObservation(kv, "ses_err", "obs_err");

    // Make kv.list throw on the first call.
    let throwOnList = true;
    const originalList = kv.list;
    kv.list = async <T>(scope: string): Promise<T[]> => {
      if (throwOnList) {
        throwOnList = false;
        throw new Error("Simulated list failure");
      }
      return originalList.call(kv, scope) as Promise<T[]>;
    };

    // First call: kv.list throws inside the try block.
    // The finally should still release the lock.
    const r1 = (await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_err" },
    })) as { summary: string };
    expect(r1.summary).toBe("test summary");

    // No graph-extract was called (list threw before extraction).
    const graphCalls1 = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls1.length).toBe(0);

    // Second call: lock should be released, so extraction proceeds.
    const r2 = (await sdk.trigger({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_err" },
    })) as { summary: string };
    expect(r2.summary).toBe("test summary");

    // Now graph-extract SHOULD have been called.
    const graphCalls2 = calls.filter(
      (c) => c.function_id === "mem::graph-extract",
    );
    expect(graphCalls2.length).toBe(1);
  });
});
