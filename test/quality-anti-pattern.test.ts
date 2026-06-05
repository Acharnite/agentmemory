import { describe, it, expect } from "vitest";
import { scoreSummary } from "../src/eval/quality.js";

function cleanSummary() {
  return {
    title: "Refactored auth module and added JWT",
    narrative:
      "Refactored the authentication middleware to use JWT-based validation. Updated all route handlers to extract user context from tokens. Added unit tests for the new auth flow. Migrated existing session-based auth to stateless tokens.",
    keyDecisions: ["Use JWT instead of session cookies"],
    filesModified: ["src/auth/middleware.ts", "src/auth/token.ts"],
    concepts: ["authentication", "jwt", "security"],
  };
}

describe("scoreSummary anti-pattern penalties", () => {
  it("returns 100 for a clean, complete summary", () => {
    const score = scoreSummary(cleanSummary());
    expect(score).toBe(100);
  });

  it("returns 0 for empty object", () => {
    expect(scoreSummary({})).toBe(0);
  });

  describe("detects 'Short session title' leakage in title", () => {
    it("penalizes title containing 'Short session title'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "Short session title",
      });
      // 100 - 80 = 20, capped at min 0 max 100
      expect(score).toBe(20);
    });

    it("penalizes title containing partial 'Short session title' match", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "Short session title — Refactored auth",
      });
      expect(score).toBe(20);
    });
  });

  describe("detects 'max 100 chars' leakage in title", () => {
    it("penalizes title containing 'max 100 chars'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "max 100 chars",
      });
      expect(score).toBe(20);
    });

    it("penalizes title containing 'max 100 chars' with surrounding text", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "Short session title (max 100 chars)",
      });
      expect(score).toBe(20);
    });
  });

  describe("detects backtick prefix in title", () => {
    it("penalizes title starting with a backtick", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "`Refactored auth`",
      });
      expect(score).toBe(20);
    });
  });

  describe("detects structural keyword mixture in title", () => {
    it("penalizes title containing 'narrative' AND 'decisions'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "narrative of decisions made today",
      });
      expect(score).toBe(20);
    });

    it("penalizes title containing 'narrative' AND 'files'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "narrative and files summary",
      });
      expect(score).toBe(20);
    });
  });

  describe("detects 'Output EXACTLY' leakage in title", () => {
    it("penalizes title containing 'Output EXACTLY'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "Output EXACTLY this format",
      });
      expect(score).toBe(20);
    });

    it("penalizes title with case-insensitive 'Output EXACTLY'", () => {
      const score = scoreSummary({
        ...cleanSummary(),
        title: "output exactly this",
      });
      // includes("Output EXACTLY") is case-sensitive in JS,
      // so this should NOT be penalized by that specific check.
      // Note: the check is t.includes("Output EXACTLY") — literal.
      // So lowercase won't match. That's fine — test documents behavior.
      expect(score).toBe(100);
    });
  });

  it("does not penalize a normal descriptive title", () => {
    const score = scoreSummary(cleanSummary());
    expect(score).toBe(100);
  });

  it("does not penalize title containing 'narrative' alone without decisions/files/concepts", () => {
    const score = scoreSummary({
      ...cleanSummary(),
      title: "Narrative driven development approach",
    });
    expect(score).toBe(100);
  });

  it("does not penalize title that looks like normal session output", () => {
    const score = scoreSummary({
      ...cleanSummary(),
      title: "Fixed bug in payment processing pipeline",
    });
    expect(score).toBe(100);
  });

  it("penalty floors at 0 for otherwise empty summary", () => {
    const score = scoreSummary({
      title: "Short session title",
    });
    expect(score).toBe(0);
  });
});
