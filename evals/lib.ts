import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { FakeBackend, okReply } from "../src/server/agent/fake-backend";
import { findAmbulancesImpl, findClinicsImpl, getInfoImpl } from "../src/server/agent/tools";
import type { HandleMap } from "../src/server/agent/handles";
import type { LLMBackend, StructuredReply, TurnInput, TurnResult } from "../src/server/agent/types";
import type { InfoTopic } from "../src/server/content/static";
import { INTENTS, LANGUAGES } from "../src/server/types";
import type { TurnOutcome } from "../src/server/worker/turn-runner";
import type { StepExpect } from "./assertions";

const OUTCOME_KINDS = ["noop", "locked", "human_mode", "welcome", "menu", "audio_only", "fast_path", "fallback", "ok", "failed"] as const satisfies readonly TurnOutcome["kind"][];
const INFO_TOPICS = ["donate", "volunteer", "about", "faq", "human_emergency", "helpline"] as const satisfies readonly InfoTopic[];

const isRegExp = (source: string) => {
  try {
    new RegExp(source, "i");
    return true;
  } catch {
    return false;
  }
};

/** StepExpect, strictly: an unknown or misspelt check fails the file instead of passing unchecked. */
const StepExpectSchema: z.ZodType<StepExpect> = z.strictObject({
  contains: z.array(z.string()).optional(),
  not_contains: z.array(z.string()).optional(),
  regex: z.string().refine(isRegExp, "not a valid regular expression").optional(),
  language: z.enum(LANGUAGES).optional(),
  intent: z.enum(INTENTS).optional(),
  number_of: z.array(z.string()).optional(),
  no_foreign_digits: z.boolean().optional(),
  no_dispatch: z.boolean().optional(),
  turn_status: z.enum(["ok", "fallback", "failed"]).optional(),
  flagged: z.boolean().optional(),
  message_count: z.number().int().min(0).optional(),
  kind: z.enum(OUTCOME_KINDS).optional(),
  max_chars: z.number().int().min(1).optional(),
});

const lookupPlace = z.string().nullable().optional();

/**
 * One scripted backend call. The lookup keys run those tools first, as the model would. In `reply`, {{AMB:<label>}} and
 * {{CLINIC:<label>}} name a fixture unit or clinic by its label (resolveLabelTokens).
 */
const FakeReplySchema = z.strictObject({
  reply: z.string(),
  language: z.enum(LANGUAGES).optional(),
  intent: z.enum(INTENTS).optional(),
  location: z.strictObject({ city: z.string().nullable(), area: z.string().nullable() }).optional(),
  needs_human: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  find_ambulances: z.strictObject({ city: lookupPlace, area: lookupPlace, query: z.string() }).optional(),
  find_clinics: z.strictObject({ city: lookupPlace }).optional(),
  get_info: z.strictObject({ topic: z.enum(INFO_TOPICS) }).optional(),
});

const StepSchema = z
  .strictObject({
    send: z.string().optional(),
    send_burst: z.array(z.string()).min(1).optional(),
    send_kind: z.enum(["audio", "location"]).optional(),
    place: z.string().optional(),
    expect: StepExpectSchema.optional(),
  })
  .superRefine((step, ctx) => {
    if ([step.send, step.send_burst, step.send_kind].filter((v) => v !== undefined).length !== 1) {
      ctx.addIssue({ code: "custom", message: "a step sends exactly one of send, send_burst or send_kind" });
    }
    if (step.place !== undefined && step.send_kind !== "location") {
      ctx.addIssue({ code: "custom", path: ["place"], message: "place goes only with send_kind: location" });
    }
  });

const ScenarioSchema = z
  .strictObject({
    name: z.string().min(1),
    safety: z.boolean().optional(),
    language: z.enum(LANGUAGES).nullable().optional(),
    first_contact: z.boolean().optional(),
    /** "fake": always the scripted backend. "claude": its assertions need the real model, so a fake run skips it. */
    backend: z.enum(["fake", "claude"]).optional(),
    /** The fake backend's script, one reply per backend call; a claude run ignores it. */
    fake_replies: z.array(FakeReplySchema).optional(),
    pause_claude: z.boolean().optional(),
    steps: z.array(StepSchema).min(1),
  })
  .superRefine((s, ctx) => {
    if (s.safety && s.backend === "claude") {
      ctx.addIssue({ code: "custom", path: ["backend"], message: "a safety scenario must run on the fake backend: script it with fake_replies instead" });
    }
    if (s.backend === "claude" && s.fake_replies !== undefined) {
      ctx.addIssue({ code: "custom", path: ["fake_replies"], message: "a backend: claude scenario never uses fake_replies" });
    }
  });

export type FakeReply = z.infer<typeof FakeReplySchema>;
export type Step = z.infer<typeof StepSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;

/** One scenario file, validated: every problem is reported with the file name and the path of the offending key. */
export function parseScenario(file: string, text: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new Error(`${file}: not valid YAML: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  const parsed = ScenarioSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${file}: ${i.path.length > 0 ? i.path.join(".") : "(top level)"}: ${i.message}`).join("\n"));
  }
  return parsed.data;
}

/** Every .yaml scenario in `dir`, in file order. One error lists each invalid file and each name used twice. */
export function loadScenarios(dir: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const errors: string[] = [];
  const fileOf = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort()) {
    let s: Scenario;
    try {
      s = parseScenario(file, readFileSync(join(dir, file), "utf8"));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    const other = fileOf.get(s.name);
    if (other !== undefined) errors.push(`${file}: name "${s.name}" is already used by ${other}`);
    else fileOf.set(s.name, file);
    scenarios.push(s);
  }
  if (errors.length > 0) throw new Error(`Invalid scenarios:\n${errors.join("\n")}`);
  return scenarios;
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
    return okReply({ ...structured, reply: resolveLabelTokens(structured.reply, labels, ctx.registry.toJSON()) });
  };
}

/** A backend call a scenario's fake_replies has no reply left for. */
export class UnscriptedCallError extends Error {
  name = "UnscriptedCallError";
  constructor() {
    super("the fake backend was called with no fake_replies left");
  }
}

/**
 * The fake backend of a scenario: each call takes the next scripted reply, in order, and a call with none left throws
 * UnscriptedCallError. The turn catches whatever a call throws and falls back, so every throw is also recorded in
 * `errors`, for the runner to fail the step instead of judging the fallback.
 */
export function scriptedBackend(replies: FakeReply[], labels: Labels): { backend: LLMBackend; errors: string[] } {
  const errors: string[] = [];
  const recorded = (step: (input: TurnInput) => Promise<TurnResult>) => async (input: TurnInput) => {
    try {
      return await step(input);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      throw e;
    }
  };
  const exhausted = (): never => {
    const e = new UnscriptedCallError();
    errors.push(e.message);
    throw e;
  };
  // FakeBackend repeats its last step, so the script ends with the one that throws.
  return { backend: new FakeBackend([...replies.map((r) => recorded(fakeStep(r, labels))), exhausted]), errors };
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
