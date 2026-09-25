import { describe, it, expect } from "vitest";
import { HandleRegistry, makeHandle, extractTokens } from "@/server/agent/handles";

describe("handles", () => {
  it("is deterministic per conversation and entity, opaque across conversations", () => {
    const a = makeHandle("ambulance", "conv-1", "amb-1");
    expect(a).toMatch(/^amb_[0-9a-f]{8}$/);
    expect(makeHandle("ambulance", "conv-1", "amb-1")).toBe(a);
    expect(makeHandle("ambulance", "conv-2", "amb-1")).not.toBe(a);
    expect(makeHandle("clinic", "conv-1", "c-1")).toMatch(/^cli_[0-9a-f]{8}$/);
  });
  it("registry resolves handles it issued and initial ones", () => {
    const r = new HandleRegistry("conv-1", { amb_deadbeef: { kind: "ambulance", id: "old" } });
    const h = r.ambulance("amb-1");
    expect(r.resolve(h)).toEqual({ kind: "ambulance", id: "amb-1" });
    expect(r.resolve("amb_deadbeef")).toEqual({ kind: "ambulance", id: "old" });
    expect(r.resolve("amb_nope")).toBeUndefined();
    expect(r.toJSON()).toEqual({ amb_deadbeef: { kind: "ambulance", id: "old" }, [h]: { kind: "ambulance", id: "amb-1" } });
  });
  it("extracts tokens", () => {
    expect(extractTokens("Call {{AMB:amb_1a2b3c4d}} or {{PHONE:helpline}} and {{CLINIC:cli_00000000}}")).toEqual([
      { kind: "AMB", value: "amb_1a2b3c4d", raw: "{{AMB:amb_1a2b3c4d}}" },
      { kind: "PHONE", value: "helpline", raw: "{{PHONE:helpline}}" },
      { kind: "CLINIC", value: "cli_00000000", raw: "{{CLINIC:cli_00000000}}" },
    ]);
  });
});
