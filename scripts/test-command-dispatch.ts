import { expect } from "bun:test";
import { parseAntigravitySubcommand } from "../src/commands/antigravity.js";

console.log("Running antigravity command dispatch tests...");

// Root command: no arguments opens the interactive control center.
expect(parseAntigravitySubcommand("")).toEqual({ action: "dashboard" });
expect(parseAntigravitySubcommand("   ")).toEqual({ action: "dashboard" });

// models
expect(parseAntigravitySubcommand("models")).toEqual({ action: "models", all: false });
expect(parseAntigravitySubcommand("  MODELS  ")).toEqual({ action: "models", all: false });
expect(parseAntigravitySubcommand("models all")).toEqual({ action: "models", all: true });
expect(parseAntigravitySubcommand("models ALL")).toEqual({ action: "models", all: true });
expect(parseAntigravitySubcommand("models  all ")).toEqual({ action: "models", all: true });

// doctor
expect(parseAntigravitySubcommand("doctor")).toEqual({ action: "doctor" });
expect(parseAntigravitySubcommand("Doctor")).toEqual({ action: "doctor" });

// Pruned flags from the pre-convergence command surface.
for (const args of ["current", "2", "remove a@example.com", "refresh", "image", "search"]) {
  const parsed = parseAntigravitySubcommand(args);
  expect(parsed.action).toBe("invalid");
  if (parsed.action === "invalid") {
    expect(parsed.message).toBe("Usage: /antigravity [models | doctor]");
  }
}

console.log("antigravity command dispatch tests passed");
