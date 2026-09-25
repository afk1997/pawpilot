import { describe, it, expect } from "vitest";
import { renderMessageForModel, renderTranscript } from "@/server/agent/transcript";

const at = new Date("2026-09-25T04:33:00Z"); // 10:03 IST
const base = { createdAt: at, contentTemplate: null, placeLabel: null, interactiveId: null, deliveryStatus: null } as const;

describe("renderMessageForModel", () => {
  it("renders text, media markers, pins and menu taps", () => {
    expect(renderMessageForModel({ ...base, role: "user", kind: "text", content: "dog injured" })).toBe("[10:03] Reporter: dog injured");
    expect(renderMessageForModel({ ...base, role: "user", kind: "audio", content: "" })).toBe("[10:03] Reporter: [voice note received — not transcribed]");
    expect(renderMessageForModel({ ...base, role: "user", kind: "image", content: "see" })).toBe("[10:03] Reporter: [photo received] see");
    expect(renderMessageForModel({ ...base, role: "user", kind: "location", content: "", placeLabel: "Karve Nagar, Pune" })).toBe("[10:03] Reporter: [location pin: Karve Nagar, Pune]");
    expect(renderMessageForModel({ ...base, role: "user", kind: "location", content: "" })).toBe("[10:03] Reporter: [location pin received]");
    expect(renderMessageForModel({ ...base, role: "user", kind: "interactive", content: "Animal ambulance", interactiveId: "menu:ambulance" })).toBe("[10:03] Reporter: [menu choice: ambulance]");
    expect(renderMessageForModel({ ...base, role: "user", kind: "sticker", content: "" })).toBe("[10:03] Reporter: [sticker]");
  });
  it("prefers the template for assistant messages so tokens, not digits, appear", () => {
    expect(renderMessageForModel({ ...base, role: "assistant", kind: "text", content: "Call +91 70000 00001", contentTemplate: "Call {{AMB:amb_1}}" })).toBe("[10:03] Assistant: Call {{AMB:amb_1}}");
  });
  it("marks an assistant reply whose send failed as not delivered", () => {
    const reply = { ...base, role: "assistant", kind: "text", content: "Call +91 70000 00001", contentTemplate: "Call {{AMB:amb_1}}" } as const;
    expect(renderMessageForModel({ ...reply, deliveryStatus: "failed" })).toBe("[10:03] Assistant: [not delivered] Call {{AMB:amb_1}}");
    expect(renderMessageForModel({ ...base, role: "assistant", kind: "text", content: "Please type the area", deliveryStatus: "failed" })).toBe("[10:03] Assistant: [not delivered] Please type the area");
    expect(renderMessageForModel({ ...reply, deliveryStatus: "sent" })).toBe("[10:03] Assistant: Call {{AMB:amb_1}}");
    expect(renderMessageForModel({ ...reply, deliveryStatus: "test_skipped" })).toBe("[10:03] Assistant: Call {{AMB:amb_1}}");
  });
});

describe("renderTranscript", () => {
  it("separates history from the new messages", () => {
    const h = [{ ...base, id: "1", role: "user" as const, kind: "text" as const, content: "hi" }];
    const p = [{ ...base, id: "2", role: "user" as const, kind: "text" as const, content: "Surat" }];
    const t = renderTranscript(h as never, p as never);
    expect(t).toBe("[10:03] Reporter: hi\n\n--- NEW MESSAGES (answer these) ---\n[10:03] Reporter: Surat");
  });
  it("shows a pending message once, under the new messages, when the history already holds it", () => {
    const hi = { ...base, id: "1", role: "user" as const, kind: "text" as const, content: "hi" };
    const surat = { ...base, id: "2", role: "user" as const, kind: "text" as const, content: "Surat" };
    expect(renderTranscript([hi, surat] as never, [surat] as never)).toBe("[10:03] Reporter: hi\n\n--- NEW MESSAGES (answer these) ---\n[10:03] Reporter: Surat");
    expect(renderTranscript([surat] as never, [surat] as never)).toBe("--- NEW MESSAGES (answer these) ---\n[10:03] Reporter: Surat");
  });
});
