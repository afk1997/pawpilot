import { describe, it, expect } from "vitest";
import {
  UsageError, allowedNumbersFor, databaseName, databaseRefusal, fakeStep, formatTable, modelReplyOf, needsClaude, parseArgs,
  resolveLabelTokens, summarize, summaryLine, type Labels, type ScenarioResult,
} from "../../../evals/lib";
import { HandleRegistry } from "@/server/agent/handles";
import type { ToolContext } from "@/server/agent/tools";
import type { TurnInput } from "@/server/agent/types";

const labels: Labels = {
  AMB: new Map([["Mumbai - Ghatkopar", "amb-id-1"], ["Mumbai - Malad", "amb-id-2"]]),
  CLINIC: new Map([["Arham Clinic Surat", "cli-id-1"]]),
};
const directory = {
  ambulances: new Map([["amb-id-1", "+917000000001"], ["amb-id-2", "+917000000002"]]),
  clinics: new Map([["cli-id-1", "+912612345678"]]),
};
const always = ["+919999900000"];

const toolContext = (registry: HandleRegistry): ToolContext => ({
  conversationId: "conv-1", language: "en", registry, calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null,
});
const turnInput = (ctx?: ToolContext): TurnInput => ({
  conversationId: "conv-1", systemPrompt: "", prompt: "", toolServer: null, allowedToolNames: [], timeoutMs: 1000, toolContext: ctx,
});
const result = (name: string, status: ScenarioResult["status"], latencies: number[] = [], safety = false): ScenarioResult => ({
  name, safety, status, failures: status === "FAIL" ? ["step 1: x"] : [], latencies,
});

describe("parseArgs", () => {
  it("defaults to the fake backend and every scenario", () => {
    expect(parseArgs([])).toEqual({ only: null, backend: "fake", allowDb: false });
  });
  it("reads --only, --backend and --allow-db", () => {
    expect(parseArgs(["--only", "donate", "--backend", "claude", "--allow-db"])).toEqual({ only: "donate", backend: "claude", allowDb: true });
    expect(parseArgs(["--backend", "fake"])).toEqual({ only: null, backend: "fake", allowDb: false });
  });
  it("refuses an unknown backend, a flag without its value and an unknown argument", () => {
    expect(() => parseArgs(["--backend", "gpt"])).toThrow(UsageError);
    expect(() => parseArgs(["--backend", "gpt"])).toThrow('Unknown backend "gpt"');
    expect(() => parseArgs(["--only"])).toThrow("--only needs a value");
    expect(() => parseArgs(["--only", "--allow-db"])).toThrow("--only needs a value");
    expect(() => parseArgs(["--bakend", "claude"])).toThrow('Unknown argument "--bakend"');
  });
});

describe("databaseName", () => {
  it("reads the database from the URL's path", () => {
    expect(databaseName("postgres://arham:arham@127.0.0.1:5439/arham_test")).toBe("arham_test");
    expect(databaseName("postgres://u:p@h/arham%5Ftest?sslmode=disable")).toBe("arham_test");
  });
  it("is null when the URL names no database or does not parse", () => {
    expect(databaseName("postgres://u:p@h:5439")).toBeNull();
    expect(databaseName("postgres://u:p@h:5439/")).toBeNull();
    expect(databaseName("not a url")).toBeNull();
  });
});

describe("databaseRefusal", () => {
  it("allows only a database whose name ends in _test", () => {
    expect(databaseRefusal("arham_test", false)).toBeNull();
    expect(databaseRefusal("arham", false)).toContain('"arham" is not a test database');
    expect(databaseRefusal("arham_testing", false)).toContain("must end in _test");
    expect(databaseRefusal(null, false)).toContain("must end in _test");
  });
  it("allows any database with --allow-db", () => {
    expect(databaseRefusal("arham", true)).toBeNull();
    expect(databaseRefusal(null, true)).toBeNull();
  });
});

describe("resolveLabelTokens", () => {
  it("replaces a label with the handle issued for it and leaves every other token as written", () => {
    const registry = new HandleRegistry("conv-1");
    const amb = registry.ambulance("amb-id-1");
    const cli = registry.clinic("cli-id-1");
    const reply = "Call {{AMB:Mumbai - Ghatkopar}}, {{CLINIC:Arham Clinic Surat}}, {{AMB:Mumbai - Malad}}, {{PHONE:helpline}} or {{AMB:amb_abcdefgh}}.";
    expect(resolveLabelTokens(reply, labels, registry.toJSON())).toBe(
      `Call {{AMB:${amb}}}, {{CLINIC:${cli}}}, {{AMB:Mumbai - Malad}}, {{PHONE:helpline}} or {{AMB:amb_abcdefgh}}.`
    );
  });
  it("never resolves a label through a handle of the other kind", () => {
    const registry = new HandleRegistry("conv-1");
    registry.clinic("amb-id-1");
    expect(resolveLabelTokens("{{AMB:Mumbai - Ghatkopar}}", labels, registry.toJSON())).toBe("{{AMB:Mumbai - Ghatkopar}}");
  });
});

describe("fakeStep", () => {
  it("answers with the scripted fields and the labels resolved", async () => {
    const registry = new HandleRegistry("conv-1");
    const handle = registry.ambulance("amb-id-1");
    const r = await fakeStep({ reply: "Call {{AMB:Mumbai - Ghatkopar}}.", language: "hi", intent: "ambulance", needs_human: true }, labels)(turnInput(toolContext(registry)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.structured).toMatchObject({ reply: `Call {{AMB:${handle}}}.`, language: "hi", intent: "ambulance", needs_human: true });
  });
  it("throws without a tool context", async () => {
    await expect(fakeStep({ reply: "Hello." }, labels)(turnInput())).rejects.toThrow("tool context");
  });
});

describe("allowedNumbersFor", () => {
  it("allows the numbers of the handles on a model turn's row, the helpline and the static phones", () => {
    const registry = new HandleRegistry("conv-1");
    registry.ambulance("amb-id-1");
    registry.clinic("cli-id-1");
    const turn = { status: "ok", model: "fake", handles: registry.toJSON(), structuredOutput: null };
    expect(allowedNumbersFor(turn, directory, always).sort()).toEqual(["+912612345678", "+917000000001", "+919999900000"]);
  });
  it("allows every unit's number on a fallback turn, which picks its units from the directory with no model", () => {
    const turn = { status: "fallback", model: "fallback", handles: null, structuredOutput: { matched: 1, matchType: "area", sent: "unit" } };
    expect(allowedNumbersFor(turn, directory, always).sort()).toEqual(["+917000000001", "+917000000002", "+919999900000"]);
  });
  it("allows only the helpline and the static phones for a system turn or no turn", () => {
    expect(allowedNumbersFor(null, directory, always)).toEqual(always);
    expect(allowedNumbersFor({ status: "ok", model: "system:welcome", handles: null, structuredOutput: null }, directory, always)).toEqual(always);
  });
  it("skips a handle whose unit is no longer in the directory", () => {
    const turn = { status: "ok", model: "fake", handles: { amb_aaaaaaaa: { kind: "ambulance", id: "retired" } }, structuredOutput: null };
    expect(allowedNumbersFor(turn, directory, always)).toEqual(always);
  });
});

describe("modelReplyOf", () => {
  const reply = { reply: "Hello.", language: "en", intent: "other", location: { city: null, area: null }, needs_human: false, notes: null };
  it("returns the structured reply of a turn the model wrote", () => {
    expect(modelReplyOf({ status: "ok", model: "fake", handles: {}, structuredOutput: reply })).toEqual(reply);
  });
  it("is null for the fallback, a system turn or no turn", () => {
    expect(modelReplyOf({ status: "fallback", model: "fallback", handles: null, structuredOutput: { matched: 1, matchType: "area", sent: "unit" } })).toBeNull();
    expect(modelReplyOf({ status: "ok", model: "system:audio", handles: null, structuredOutput: null })).toBeNull();
    expect(modelReplyOf(null)).toBeNull();
  });
});

describe("needsClaude", () => {
  it("skips a claude-only scenario on a fake run only", () => {
    expect(needsClaude({ backend: "claude" }, false)).toBe(true);
    expect(needsClaude({ backend: "claude" }, true)).toBe(false);
    expect(needsClaude({ backend: "fake" }, false)).toBe(false);
    expect(needsClaude({}, false)).toBe(false);
  });
});

describe("summarize", () => {
  it("passes a run with no failure and counts skips apart", () => {
    const s = summarize([result("a", "PASS", [10, 30]), result("b", "SKIP"), result("c", "PASS", [20])]);
    expect(s).toEqual({ ran: 2, passed: 2, skipped: 1, safetyFailed: 0, p50: 20, p95: 30, exitCode: 0 });
    expect(summaryLine(s)).toBe("2/2 scenarios passed · 1 skipped (need claude) · safety failures: 0 · turn latency P50 20 ms, P95 30 ms");
  });
  it("fails a run with any failure and counts the safety ones", () => {
    const s = summarize([result("a", "FAIL", [5], true), result("b", "FAIL"), result("c", "PASS", [7])]);
    expect(s).toMatchObject({ ran: 3, passed: 1, skipped: 0, safetyFailed: 1, exitCode: 1 });
    expect(summaryLine(s)).toBe("1/3 scenarios passed · safety failures: 1 · turn latency P50 7 ms, P95 7 ms");
  });
  it("exits 0 when every scenario was skipped", () => {
    expect(summarize([result("a", "SKIP")])).toEqual({ ran: 0, passed: 0, skipped: 1, safetyFailed: 0, p50: 0, p95: 0, exitCode: 0 });
  });
});

describe("formatTable", () => {
  it("aligns the columns and lists each turn's latency", () => {
    expect(formatTable([result("alpha", "PASS", [12, 9], true), result("b", "SKIP")])).toEqual([
      "scenario  safety  result  turn latency",
      "alpha     yes     PASS    12, 9 ms",
      `b${" ".repeat(17)}SKIP    -`,
    ]);
  });
});
