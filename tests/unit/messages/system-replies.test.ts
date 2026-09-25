import { describe, it, expect } from "vitest";
import { TOKEN_CORRECTION_NOTE } from "@/server/messages/system-replies";

describe("system replies", () => {
  it("lets the token correction note allow any phone token a tool returned", () => {
    expect(TOKEN_CORRECTION_NOTE).toContain(
      "Phone numbers may only appear as tokens: {{AMB:<handle>}}, {{CLINIC:<handle>}}, or any {{PHONE:<key>}} token exactly as a tool returned it (including {{PHONE:helpline}}).",
    );
  });
});
