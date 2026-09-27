import { describe, it, expect } from "vitest";
import { TOKEN_CORRECTION_NOTE, firstContactGreeting, staleHandleNote } from "@/server/messages/system-replies";

describe("system replies", () => {
  it("lets the token correction note allow any phone token a tool returned", () => {
    expect(TOKEN_CORRECTION_NOTE).toContain(
      "Phone numbers may only appear as tokens: {{AMB:<handle>}}, {{CLINIC:<handle>}}, or any {{PHONE:<key>}} token exactly as a tool returned it (including {{PHONE:helpline}}).",
    );
  });

  it("names the retired handles with the tool for their kind, never the digits wording", () => {
    const note = staleHandleNote(["amb_abcdefgh", "cli_ponmlkji", "AMB_ABCDEFGH"]);
    expect(note).toContain("amb_abcdefgh");
    expect(note).toContain("cli_ponmlkji");
    expect(note.match(/amb_abcdefgh/gi)).toHaveLength(1);
    expect(note).toMatch(/amb_abcdefgh[^.;]*find_ambulances/);
    expect(note).toMatch(/cli_ponmlkji[^.;]*find_clinics/);
    expect(note).not.toMatch(/digit/i);
    expect(note).not.toMatch(/\d/);
  });

  it("greets a first message in each language, in one short line with no digits", () => {
    expect(firstContactGreeting("en")).toBe("Namaste! 🙏");
    expect(firstContactGreeting("hi")).toBe("नमस्ते! 🙏");
    expect(firstContactGreeting("mr")).toBe("नमस्कार! 🙏");
    expect(firstContactGreeting("gu")).toBe("નમસ્તે! 🙏");
    for (const lang of ["en", "hi", "mr", "gu"] as const) {
      expect(firstContactGreeting(lang)).not.toMatch(/\n|\d/);
      expect(firstContactGreeting(lang).length).toBeLessThan(20);
    }
  });

  it("names only handle-shaped values, so no digits or odd text reach the prompt", () => {
    const note = staleHandleNote(["amb_abcdefgh", "amb_9876543210", "cli_x"]);
    expect(note).toContain("amb_abcdefgh");
    expect(note).not.toMatch(/\d/);
    expect(note).not.toContain("cli_x");
  });
});
