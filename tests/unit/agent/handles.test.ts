import { describe, it, expect } from "vitest";
import { HandleRegistry, makeHandle, extractTokens, TOKEN_RE } from "@/server/agent/handles";

describe("handles", () => {
  it("is deterministic per conversation and entity, opaque across conversations", () => {
    const a = makeHandle("ambulance", "conv-1", "amb-1");
    expect(a).toMatch(/^amb_[a-p]{8}$/);
    expect(makeHandle("ambulance", "conv-1", "amb-1")).toBe(a);
    expect(makeHandle("ambulance", "conv-2", "amb-1")).not.toBe(a);
    expect(makeHandle("clinic", "conv-1", "c-1")).toMatch(/^cli_[a-p]{8}$/);
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
  it("extracts every token even after a caller has used the shared TOKEN_RE", () => {
    expect(TOKEN_RE.test("{{AMB:amb_1a2b3c4d}}")).toBe(true);
    expect(TOKEN_RE.lastIndex).toBeGreaterThan(0);
    try {
      expect(extractTokens("Call {{AMB:amb_1a2b3c4d}} or {{PHONE:helpline}} and {{CLINIC:cli_00000000}}")).toEqual([
        { kind: "AMB", value: "amb_1a2b3c4d", raw: "{{AMB:amb_1a2b3c4d}}" },
        { kind: "PHONE", value: "helpline", raw: "{{PHONE:helpline}}" },
        { kind: "CLINIC", value: "cli_00000000", raw: "{{CLINIC:cli_00000000}}" },
      ]);
    } finally {
      TOKEN_RE.lastIndex = 0;
    }
  });
  it("resolves only its own handles, never inherited object keys", () => {
    const r = new HandleRegistry("conv-1", { amb_deadbeef: { kind: "ambulance", id: "old" } });
    const h = r.ambulance("amb-1");
    expect(r.resolve("constructor")).toBeUndefined();
    expect(r.resolve("__proto__")).toBeUndefined();
    const json = r.toJSON();
    expect(Object.hasOwn(json, "constructor")).toBe(false);
    expect(Object.hasOwn(json, "__proto__")).toBe(false);
    expect(Object.keys(json)).toEqual(["amb_deadbeef", h]);
  });
  it("refuses to point an existing handle at a different entity", () => {
    const amb = makeHandle("ambulance", "conv-1", "amb-1");
    const cli = makeHandle("clinic", "conv-1", "c-1");
    const r = new HandleRegistry("conv-1", { [amb]: { kind: "ambulance", id: "amb-other" }, [cli]: { kind: "clinic", id: "c-other" } });
    expect(() => r.ambulance("amb-1")).toThrow("handle collision");
    expect(() => r.clinic("c-1")).toThrow("handle collision");
    expect(r.toJSON()).toEqual({ [amb]: { kind: "ambulance", id: "amb-other" }, [cli]: { kind: "clinic", id: "c-other" } });
  });
  it("re-issues the same handle for the same entity", () => {
    const amb = makeHandle("ambulance", "conv-1", "amb-1");
    const r = new HandleRegistry("conv-1", { [amb]: { kind: "ambulance", id: "amb-1" } });
    expect(r.ambulance("amb-1")).toBe(amb);
    expect(r.ambulance("amb-1")).toBe(amb);
    expect(r.handles()).toEqual([amb]);
  });
  it("resolves handles case-insensitively, still own keys only", () => {
    const r = new HandleRegistry("conv-1");
    const h = r.ambulance("amb-1");
    expect(r.resolve(h.toUpperCase())).toEqual({ kind: "ambulance", id: "amb-1" });
    expect(r.resolve("CONSTRUCTOR")).toBeUndefined();
    expect(r.resolve("__PROTO__")).toBeUndefined();
  });
  it("extracts PHONE keys with digits and underscores", () => {
    expect(extractTokens("FAQ {{PHONE:faq_1}}, volunteers {{PHONE:volunteer_contact_phone}}")).toEqual([
      { kind: "PHONE", value: "faq_1", raw: "{{PHONE:faq_1}}" },
      { kind: "PHONE", value: "volunteer_contact_phone", raw: "{{PHONE:volunteer_contact_phone}}" },
    ]);
  });
});
