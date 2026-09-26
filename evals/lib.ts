import { okReply } from "../src/server/agent/fake-backend";
import { findAmbulancesImpl, findClinicsImpl, getInfoImpl } from "../src/server/agent/tools";
import type { HandleMap } from "../src/server/agent/handles";
import type { StructuredReply, TurnInput, TurnResult } from "../src/server/agent/types";
import type { InfoTopic } from "../src/server/content/static";
import type { Language } from "../src/server/types";
import type { StepExpect } from "./assertions";

/**
 * One scripted backend call. The lookup keys run those tools first, as the model would. In `reply`, {{AMB:<label>}} and
 * {{CLINIC:<label>}} name a fixture unit or clinic by its label (resolveLabelTokens).
 */
export interface FakeReply extends Partial<StructuredReply> {
  find_ambulances?: { city?: string | null; area?: string | null; query: string };
  find_clinics?: { city?: string | null };
  get_info?: { topic: InfoTopic };
}

export interface Step {
  send?: string;
  send_burst?: string[];
  send_kind?: "audio" | "location";
  place?: string;
  expect?: StepExpect;
}

export interface Scenario {
  name: string;
  safety?: boolean;
  language?: Language | null;
  first_contact?: boolean;
  /** "fake": always the scripted backend. "claude": its assertions need the real model, so a fake run skips it. */
  backend?: "fake" | "claude";
  /** The fake backend's script, one reply per backend call; a claude run ignores it. */
  fake_replies?: FakeReply[];
  pause_claude?: boolean;
  steps: Step[];
}

/** A bad command line: the runner prints it with the usage and exits 2. */
export class UsageError extends Error {
  name = "UsageError";
}

export interface EvalArgs {
  only: string | null;
  backend: "fake" | "claude";
  allowDb: boolean;
}

/** The runner's arguments: --only <name>, --backend fake|claude (fake when absent) and --allow-db; anything else throws. */
export function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { only: null, backend: "fake", allowDb: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-db") {
      args.allowDb = true;
    } else if (arg === "--only" || arg === "--backend") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      i += 1;
      if (arg === "--only") args.only = value;
      else if (value === "fake" || value === "claude") args.backend = value;
      else throw new UsageError(`Unknown backend "${value}"`);
    } else {
      throw new UsageError(`Unknown argument "${arg}"`);
    }
  }
  return args;
}

/** The database a connection URL names in its path, or null when it names none or does not parse. */
export function databaseName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

/**
 * Why the eval must not run against the database `name`, or null when it may: every scenario truncates every table, so
 * only a database whose name ends in _test, unless the caller passed --allow-db.
 */
export function databaseRefusal(name: string | null, allowDb: boolean): string | null {
  if (allowDb || name?.endsWith("_test")) return null;
  return (
    `Refusing to run: the eval truncates every table, and ${name === null ? "the database name is unknown, so it" : `"${name}"`} ` +
    "is not a test database (its name must end in _test). Point TEST_DATABASE_URL at one, or pass --allow-db to run against it anyway."
  );
}

/** Fixture labels to their unit or clinic ids, by token kind. */
export type Labels = Record<"AMB" | "CLINIC", Map<string, string>>;

/** A fixture label in a scripted reply: {{AMB:Mumbai - Ghatkopar}}, {{CLINIC:Arham Clinic Surat}}. */
const LABEL_TOKEN_RE = /\{\{(AMB|CLINIC):([^{}]+)\}\}/g;

/**
 * The reply with each {{AMB:<label>}} and {{CLINIC:<label>}} naming the handle `issued` holds for that unit or clinic: a
 * handle a lookup gave the model, in this turn or an earlier one. A label no lookup issued stays as written, so the
 * reply drops it like an invented handle; tokens that name no label (handles, PHONE keys) stay as they are.
 */
export function resolveLabelTokens(reply: string, labels: Labels, issued: HandleMap): string {
  const entries = Object.entries(issued);
  return reply.replace(LABEL_TOKEN_RE, (raw, kind: "AMB" | "CLINIC", label: string) => {
    const id = labels[kind].get(label.trim());
    const handleKind = kind === "AMB" ? "ambulance" : "clinic";
    const handle = id === undefined ? undefined : entries.find(([, ref]) => ref.kind === handleKind && ref.id === id)?.[0];
    return handle === undefined ? raw : `{{${kind}:${handle}}}`;
  });
}

/** A FakeBackend step for one scripted reply: its lookups against the turn's tool context, then the reply. */
export function fakeStep(r: FakeReply, labels: Labels): (input: TurnInput) => Promise<TurnResult> {
  const { find_ambulances, find_clinics, get_info, ...structured } = r;
  return async (input) => {
    const ctx = input.toolContext;
    if (!ctx) throw new Error("the fake backend got no tool context");
    if (find_ambulances) await findAmbulancesImpl(ctx, find_ambulances);
    if (find_clinics) await findClinicsImpl(ctx, find_clinics);
    if (get_info) getInfoImpl(ctx, get_info);
    return okReply({ ...structured, reply: resolveLabelTokens(structured.reply ?? "", labels, ctx.registry.toJSON()) });
  };
}

/** The phone numbers of the active directory, by unit or clinic id. */
export interface Directory {
  ambulances: Map<string, string>;
  clinics: Map<string, string>;
}

/** The fields of a turn row a step is judged on. */
export interface JudgedTurn {
  status: string;
  model: string | null;
  handles: unknown;
  structuredOutput: unknown;
}

/** The no-LLM fallback (status "fallback") and the welcome, menu and voice-note turns (model "system:…") are code alone. */
const isCodeOnly = (turn: JudgedTurn) => turn.status === "fallback" || (turn.model ?? "").startsWith("system:");

/** The model's structured reply on the step's turn row; null for a turn code wrote alone, or no turn. */
export function modelReplyOf(turn: JudgedTurn | null): StructuredReply | null {
  if (turn === null || isCodeOnly(turn)) return null;
  return (turn.structuredOutput as StructuredReply | null) ?? null;
}

/**
 * The numbers a step's messages may show (StepActual.allowedNumbers): `always` (the helpline and the static content's
 * phones), the numbers of the handles on the step's turn row, and for the no-LLM fallback every unit's number, since it
 * picks its units from the directory with no model involved. A handle whose unit or clinic left the directory adds none.
 */
export function allowedNumbersFor(turn: JudgedTurn | null, directory: Directory, always: string[]): string[] {
  if (turn?.status === "fallback") return [...always, ...directory.ambulances.values()];
  const handles = turn?.handles !== null && typeof turn?.handles === "object" ? Object.values(turn.handles as HandleMap) : [];
  const phones = handles.map((ref) => (ref.kind === "ambulance" ? directory.ambulances : directory.clinics).get(ref.id));
  return [...always, ...phones.filter((p): p is string => p !== undefined)];
}

/** Whether this run skips the scenario: one that needs the real model, on a fake run. */
export function needsClaude(s: Pick<Scenario, "backend">, useClaude: boolean): boolean {
  return s.backend === "claude" && !useClaude;
}

export interface ScenarioResult {
  name: string;
  safety: boolean;
  status: "PASS" | "FAIL" | "SKIP";
  failures: string[];
  latencies: number[];
}

export interface Summary {
  ran: number;
  passed: number;
  skipped: number;
  safetyFailed: number;
  p50: number;
  p95: number;
  /** 1 when any scenario that ran failed; skipped ones never fail a run. */
  exitCode: 0 | 1;
}

export function summarize(results: ScenarioResult[]): Summary {
  const ran = results.filter((r) => r.status !== "SKIP");
  const latencies = ran.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const pct = (p: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] : 0);
  const passed = ran.filter((r) => r.status === "PASS").length;
  return {
    ran: ran.length,
    passed,
    skipped: results.length - ran.length,
    safetyFailed: ran.filter((r) => r.safety && r.status === "FAIL").length,
    p50: pct(50),
    p95: pct(95),
    exitCode: passed === ran.length ? 0 : 1,
  };
}

export function summaryLine(s: Summary): string {
  const skipped = s.skipped ? ` · ${s.skipped} skipped (need claude)` : "";
  return `${s.passed}/${s.ran} scenarios passed${skipped} · safety failures: ${s.safetyFailed} · turn latency P50 ${s.p50} ms, P95 ${s.p95} ms`;
}

/** One line per scenario under a header: name, safety flag, result and each turn's latency. */
export function formatTable(results: ScenarioResult[]): string[] {
  const rows = [
    ["scenario", "safety", "result", "turn latency"],
    ...results.map((r) => [r.name, r.safety ? "yes" : "", r.status, r.latencies.length ? `${r.latencies.join(", ")} ms` : "-"]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  return rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
}
