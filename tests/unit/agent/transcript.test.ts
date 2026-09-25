import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderMessageForModel, renderTranscript } from "@/server/agent/transcript";
import { buildAmbulanceCard, buildHelplineCard } from "@/server/messages/cards";
import { audioNotSupported, fallbackFoundIntro } from "@/server/messages/system-replies";
import { welcomeText } from "@/server/messages/welcome";

const at = new Date("2026-09-25T04:33:00Z"); // 10:03 IST
const base = { createdAt: at, contentTemplate: null, placeLabel: null, interactiveId: null, deliveryStatus: null, origin: "agent" } as const;
/** A phone-shaped run: 7+ digits, at most one space or hyphen between two digits. */
const PHONE_SHAPED = /\d(?:[ -]?\d){6,}/;

// `now` defaults to the clock; pinning the clock to `at` keeps same-day stamps bare in the tests that omit it.
beforeEach(() => {
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.useRealTimers();
});

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
  it("masks the numbers in a reply without a template and labels it an automatic reply", () => {
    const unit = { city: "Mumbai", area: "Ghatkopar", phone: "+917000000001", operatorName: "Arham", operatorIsArham: true };
    const card = renderMessageForModel({ ...base, role: "assistant", kind: "text", origin: "fallback", content: `${fallbackFoundIntro("en")}\n\n${buildAmbulanceCard(unit, "en")}` });
    expect(card).toBe("[10:03] Assistant (automatic reply): Here is the animal ambulance for your area:\n\nArham Animal Ambulance, Ghatkopar\n[number sent]\nPlease call them right away.");
    expect(card).not.toMatch(PHONE_SHAPED);
    const helpline = renderMessageForModel({ ...base, role: "assistant", kind: "text", origin: "fallback", content: buildHelplineCard("+919999900000", "en"), deliveryStatus: "failed" });
    expect(helpline).toBe("[10:03] Assistant (automatic reply): [not delivered] Please call the Arham Always Care helpline and our team will help you:\n[number sent]");
  });
  it("labels helpline staff and system rows, masks native-numeral and toll-free numbers, and never dumps the menu", () => {
    const staff = renderMessageForModel({ ...base, role: "assistant", kind: "text", origin: "human", content: "Driver ka number ९८२०० १२३४५ hai, ya 1800-419-5860 par call karein" });
    expect(staff).toBe("[10:03] Helpline staff: Driver ka number [number sent] hai, ya [number sent] par call karein");
    expect(staff).not.toMatch(PHONE_SHAPED);
    const menu = { ...base, role: "assistant", kind: "interactive", origin: "system", content: welcomeText("en") } as const;
    expect(renderMessageForModel(menu)).toBe("[10:03] System: [welcome/menu list sent]");
    expect(renderMessageForModel({ ...menu, deliveryStatus: "failed" })).toBe("[10:03] System: [not delivered] [welcome/menu list sent]");
    expect(renderMessageForModel({ ...base, role: "assistant", kind: "text", origin: "system", content: audioNotSupported("en") })).toBe(`[10:03] System: ${audioNotSupported("en")}`);
  });
  it("prefixes the date when the IST day differs from now, and writes 00:15 after midnight", () => {
    const row = { ...base, role: "user", kind: "text", content: "dog injured" } as const;
    expect(renderMessageForModel({ ...row, createdAt: new Date("2026-09-24T04:33:00Z") }, at)).toBe("[24 Sep 10:03] Reporter: dog injured");
    // 18:45Z on the 24th is 00:15 IST on the 25th: the same IST day as `at`, so no date even though the UTC days differ.
    expect(renderMessageForModel({ ...row, createdAt: new Date("2026-09-24T18:45:00Z") }, at)).toBe("[00:15] Reporter: dog injured");
    expect(renderMessageForModel({ ...row, createdAt: new Date("2026-09-24T18:15:00Z") }, at)).toBe("[24 Sep 23:45] Reporter: dog injured");
    expect(renderMessageForModel({ ...row, createdAt: new Date("2025-09-24T04:33:00Z") }, at)).toBe("[24 Sep 2025 10:03] Reporter: dog injured");
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
  it("stamps every line against the now it is given", () => {
    const hi = { ...base, id: "1", role: "user" as const, kind: "text" as const, content: "hi", createdAt: new Date("2026-09-24T04:33:00Z") };
    const surat = { ...base, id: "2", role: "user" as const, kind: "text" as const, content: "Surat" };
    const nextDay = new Date("2026-09-26T04:33:00Z");
    expect(renderTranscript([hi, surat] as never, [surat] as never, nextDay)).toBe("[24 Sep 10:03] Reporter: hi\n\n--- NEW MESSAGES (answer these) ---\n[25 Sep 10:03] Reporter: Surat");
  });
});
