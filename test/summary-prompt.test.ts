import { describe, it, expect } from "vitest";
import {
  SUMMARY_SYSTEM,
  REDUCE_SYSTEM,
  buildSummaryPrompt,
  buildReducePrompt,
} from "../src/prompts/summary.js";

describe("SUMMARY_SYSTEM (commit 5453969 — prevent prompt leakage)", () => {
  it('instructs "Output ONLY valid XML"', () => {
    expect(SUMMARY_SYSTEM).toContain("Output ONLY valid XML");
  });

  it('instructs "No preamble, no reasoning, no markdown"', () => {
    expect(SUMMARY_SYSTEM).toContain("No preamble, no reasoning, no markdown");
  });

  it('does NOT contain "Output EXACTLY this XML format"', () => {
    // Old style — was replaced with "Output ONLY valid XML"
    expect(SUMMARY_SYSTEM).not.toContain("Output EXACTLY this XML format");
    expect(SUMMARY_SYSTEM).not.toContain("Output EXACTLY this");
  });

  it('does NOT contain "max 100 chars" as raw text (only in XML comments)', () => {
    // "max 100 chars" should only appear inside <!-- --> blocks
    const commentMatches = SUMMARY_SYSTEM.match(/<!--[^>]*max 100 chars[^>]*-->/g);
    expect(commentMatches).not.toBeNull();
    // Count occurrences outside comments
    const withoutComments = SUMMARY_SYSTEM.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toContain("max 100 chars");
  });

  it('does NOT contain "Short session title" as raw text (only in XML comments)', () => {
    const withoutComments = SUMMARY_SYSTEM.replace(/<!--[\s\S]*?-->/g, "");
    expect(withoutComments).not.toContain("Short session title");
  });

  it("contains XML comments with instructional text inside them", () => {
    // The XML template should use comments to describe what goes in each tag
    const commentPattern = /<!--\s*[^>]*\s*-->/;
    expect(SUMMARY_SYSTEM).toMatch(commentPattern);
    // Should have at least one <!-- in the XML template section
    expect(SUMMARY_SYSTEM).toContain("<!-- max 100 chars");
    expect(SUMMARY_SYSTEM).toContain("<!-- 3-5 sentences");
    expect(SUMMARY_SYSTEM).toContain("<!-- one key decision -->");
    expect(SUMMARY_SYSTEM).toContain("<!-- path to file -->");
    expect(SUMMARY_SYSTEM).toContain("<!-- searchable keyword -->");
  });

  it('contains DO NOT instructions about reasoning and fences', () => {
    expect(SUMMARY_SYSTEM).toContain("DO NOT include your analysis, reasoning");
    expect(SUMMARY_SYSTEM).toContain("DO NOT wrap the XML in markdown code fences");
  });

  it("has a valid XML template structure", () => {
    // Verify the XML-like template section has proper opening/closing tags
    const templateSection = SUMMARY_SYSTEM.match(/<summary>[\s\S]*?<\/summary>/);
    expect(templateSection).not.toBeNull();
    expect(templateSection![0]).toContain("<title>");
    expect(templateSection![0]).toContain("</title>");
    expect(templateSection![0]).toContain("<narrative>");
    expect(templateSection![0]).toContain("</narrative>");
    expect(templateSection![0]).toContain("<decisions>");
    expect(templateSection![0]).toContain("<decision>");
    expect(templateSection![0]).toContain("</decision>");
    expect(templateSection![0]).toContain("</decisions>");
    expect(templateSection![0]).toContain("<files>");
    expect(templateSection![0]).toContain("<file>");
    expect(templateSection![0]).toContain("</file>");
    expect(templateSection![0]).toContain("</files>");
    expect(templateSection![0]).toContain("<concepts>");
    expect(templateSection![0]).toContain("<concept>");
    expect(templateSection![0]).toContain("</concept>");
    expect(templateSection![0]).toContain("</concepts>");
  });
});

describe("REDUCE_SYSTEM", () => {
  it('instructs "Output ONLY valid XML"', () => {
    expect(REDUCE_SYSTEM).toContain("Output ONLY valid XML");
  });

  it('does NOT contain "Output EXACTLY this XML format"', () => {
    expect(REDUCE_SYSTEM).not.toContain("Output EXACTLY this XML format");
  });

  it("contains XML comments with instructional text", () => {
    expect(REDUCE_SYSTEM).toContain("<!-- max 100 chars");
    expect(REDUCE_SYSTEM).toContain("<!-- 3-5 sentences");
    expect(REDUCE_SYSTEM).toContain("<!-- one key decision -->");
    expect(REDUCE_SYSTEM).toContain("<!-- path to file -->");
    expect(REDUCE_SYSTEM).toContain("<!-- searchable keyword -->");
  });

  it('contains DO NOT instructions about reasoning and fences', () => {
    expect(REDUCE_SYSTEM).toContain("DO NOT include your analysis, reasoning");
    expect(REDUCE_SYSTEM).toContain("DO NOT wrap the XML in markdown code fences");
  });
});

describe("buildSummaryPrompt", () => {
  const observations = [
    {
      type: "file_edit",
      title: "Refactored auth middleware",
      facts: ["Replaced session auth with JWT", "Added token validation"],
      narrative: "Updated the authentication middleware to use JWT tokens.",
      files: ["src/auth/middleware.ts"],
      concepts: ["jwt", "authentication"],
    },
    {
      type: "test",
      title: "Added auth tests",
      facts: ["Covered login flow", "Covered token refresh"],
      narrative: "Wrote unit tests for the new JWT auth flow.",
      files: ["tests/auth.test.ts"],
      concepts: ["testing"],
    },
  ];

  it("includes observation count", () => {
    const prompt = buildSummaryPrompt(observations);
    expect(prompt).toContain("Session observations (2 total)");
  });

  it("includes each observation's title", () => {
    const prompt = buildSummaryPrompt(observations);
    expect(prompt).toContain("Refactored auth middleware");
    expect(prompt).toContain("Added auth tests");
  });

  it("includes facts for each observation", () => {
    const prompt = buildSummaryPrompt(observations);
    expect(prompt).toContain("Replaced session auth with JWT");
    expect(prompt).toContain("Added token validation");
    expect(prompt).toContain("Covered login flow");
  });

  it("includes files for each observation", () => {
    const prompt = buildSummaryPrompt(observations);
    expect(prompt).toContain("src/auth/middleware.ts");
    expect(prompt).toContain("tests/auth.test.ts");
  });

  it("includes narratives", () => {
    const prompt = buildSummaryPrompt(observations);
    expect(prompt).toContain("Updated the authentication middleware");
    expect(prompt).toContain("Wrote unit tests for the new JWT auth flow");
  });

  it("separates observations with a delimiter", () => {
    const prompt = buildSummaryPrompt(observations);
    // Two observations should have one separator between them
    expect(prompt).toContain("---");
  });

  it("returns correct format for single observation", () => {
    const single = [observations[0]];
    const prompt = buildSummaryPrompt(single);
    expect(prompt).toContain("Session observations (1 total)");
    expect(prompt).not.toContain("---");
  });
});

describe("buildReducePrompt", () => {
  const partials = [
    {
      title: "Chunk 1: Auth refactor",
      narrative: "Refactored auth in first half of the session.",
      keyDecisions: ["Use JWT"],
      filesModified: ["src/auth/middleware.ts"],
      concepts: ["jwt"],
      obsRangeStart: 1,
      obsRangeEnd: 200,
    },
    {
      title: "Chunk 2: Auth tests",
      narrative: "Added tests in second half.",
      keyDecisions: ["Use vitest for testing"],
      filesModified: ["tests/auth.test.ts"],
      concepts: ["testing"],
      obsRangeStart: 201,
      obsRangeEnd: 400,
    },
  ];

  it("includes chunk count", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("Partial summaries (2 chunks");
  });

  it("includes each partial's title", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("Chunk 1: Auth refactor");
    expect(prompt).toContain("Chunk 2: Auth tests");
  });

  it("includes observation range for each chunk", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("obs 1-200");
    expect(prompt).toContain("obs 201-400");
  });

  it("includes decisions", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("Use JWT");
    expect(prompt).toContain("Use vitest for testing");
  });

  it("separates partials with a delimiter", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("---");
  });

  it("includes the 'one session' context tag", () => {
    const prompt = buildReducePrompt(partials);
    expect(prompt).toContain("chunks of one session");
  });
});
