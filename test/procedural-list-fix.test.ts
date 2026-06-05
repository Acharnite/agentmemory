import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryKV } from "../src/mcp/in-memory-kv.js";
import type { ProceduralMemory } from "../src/types.js";

const PROCEDURAL_SCOPE = "mem:procedural";

describe("memory_procedural_list fix — kv.list(KV.procedural)", () => {
  let kv: InMemoryKV;

  beforeEach(() => {
    kv = new InMemoryKV();
  });

  it("returns seeded procedural memories via kv.list", async () => {
    const now = new Date().toISOString();

    const proc1: ProceduralMemory = {
      id: "proc_abc123",
      name: "Debug memory recall failures",
      steps: [
        "Check agentmemory connection health via health endpoint",
        "Search agentmemory for recent recurrence pattern",
        "Verify observation sequence matches expected timeline",
      ],
      triggerCondition: "When user reports memories not being recalled",
      expectedOutcome: "Root cause identified and resolution documented",
      frequency: 3,
      sourceSessionIds: ["session_001"],
      tags: ["debugging", "recall"],
      concepts: ["agentmemory", "troubleshooting"],
      strength: 0.85,
      createdAt: now,
      updatedAt: now,
    };

    const proc2: ProceduralMemory = {
      id: "proc_def456",
      name: "Rotate API keys",
      steps: [
        "Generate new key via admin console",
        "Update .env.local with new key",
        "Restart the service",
        "Verify old key is revoked",
      ],
      triggerCondition: "Every 90 days or after a security incident",
      frequency: 4,
      sourceSessionIds: ["session_002", "session_003"],
      tags: ["security", "maintenance"],
      strength: 0.72,
      createdAt: now,
      updatedAt: now,
    };

    const proc3: ProceduralMemory = {
      id: "proc_ghi789",
      name: "Onboard new team member",
      steps: [
        "Grant repository access",
        "Add to CI/CD pipeline permissions",
        "Schedule pair programming sessions",
        "Assign onboarding buddy",
      ],
      triggerCondition: "When a new engineer joins the team",
      expectedOutcome: "New hire productive within first sprint",
      frequency: 2,
      sourceSessionIds: ["session_004"],
      tags: ["onboarding", "team"],
      concepts: ["hiring", "engineering"],
      strength: 0.9,
      createdAt: now,
      updatedAt: now,
    };

    // Seed the KV store under the procedural scope
    await kv.set(PROCEDURAL_SCOPE, proc1.id, proc1);
    await kv.set(PROCEDURAL_SCOPE, proc2.id, proc2);
    await kv.set(PROCEDURAL_SCOPE, proc3.id, proc3);

    // This is the exact call the fix uses (line 248 of server.ts)
    const result = await kv.list<ProceduralMemory>(PROCEDURAL_SCOPE);

    // The new approach returns the seeded data (unlike the old code
    // that went through the HTTP wrapper and read the wrong path)
    expect(result).toHaveLength(3);

    // All seeded IDs are present
    const ids = result.map((p) => p.id).sort();
    expect(ids).toEqual(["proc_abc123", "proc_def456", "proc_ghi789"]);

    // Full object integrity — each proc matches what was seeded
    const found1 = result.find((p) => p.id === "proc_abc123")!;
    expect(found1.name).toBe("Debug memory recall failures");
    expect(found1.steps).toHaveLength(3);
    expect(found1.triggerCondition).toContain("memories not being recalled");
    expect(found1.frequency).toBe(3);
    expect(found1.strength).toBe(0.85);
    expect(found1.tags).toEqual(["debugging", "recall"]);
    expect(found1.concepts).toEqual(["agentmemory", "troubleshooting"]);
    expect(found1.createdAt).toBe(now);
    expect(found1.updatedAt).toBe(now);

    const found2 = result.find((p) => p.id === "proc_def456")!;
    expect(found2.name).toBe("Rotate API keys");
    expect(found2.steps).toHaveLength(4);
    expect(found2.frequency).toBe(4);
    expect(found2.strength).toBe(0.72);
    expect(found2.expectedOutcome).toBeUndefined();

    const found3 = result.find((p) => p.id === "proc_ghi789")!;
    expect(found3.name).toBe("Onboard new team member");
    expect(found3.steps).toHaveLength(4);
    expect(found3.triggerCondition).toBe("When a new engineer joins the team");
    expect(found3.frequency).toBe(2);
    expect(found3.strength).toBe(0.9);
  });

  it("returns empty array when no procedural memories exist", async () => {
    const result = await kv.list<ProceduralMemory>(PROCEDURAL_SCOPE);
    expect(result).toEqual([]);
  });

  it("does not leak data from other KV scopes", async () => {
    const now = new Date().toISOString();

    // Seed data in a different scope (e.g. memories)
    await kv.set("mem:memories", "mem_001", {
      id: "mem_001",
      title: "Some memory",
      content: "should not appear in procedural list",
      type: "fact",
      createdAt: now,
      updatedAt: now,
    });

    // Seed a procedural memory
    const proc: ProceduralMemory = {
      id: "proc_only",
      name: "Only procedural proc",
      steps: ["Do the thing"],
      triggerCondition: "When needed",
      frequency: 1,
      sourceSessionIds: [],
      strength: 0.5,
      createdAt: now,
      updatedAt: now,
    };
    await kv.set(PROCEDURAL_SCOPE, proc.id, proc);

    const result = await kv.list<ProceduralMemory>(PROCEDURAL_SCOPE);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("proc_only");
  });
});
