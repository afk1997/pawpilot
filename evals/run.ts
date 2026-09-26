import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { checkStep, type StepExpect } from "./assertions";
import { getConfig, resetConfigForTests } from "../src/server/config";
import { getDb, closeDb } from "../src/server/db/client";
import { conversations, messages, turns } from "../src/server/db/schema";
import { storeReporterMessage } from "../src/server/inbound/store";
import { runTurn } from "../src/server/worker/turn-runner";
import { pauseClaude, clearClaudePause } from "../src/server/worker/pause";
import { stopBoss } from "../src/server/queue/boss";
import { getBackend } from "../src/server/agent";
import { FakeBackend, okReply } from "../src/server/agent/fake-backend";
import { findAmbulancesImpl, findClinicsImpl, getInfoImpl } from "../src/server/agent/tools";
import { getStaticPhones, type InfoTopic } from "../src/server/content/static";
import { resetCoverageCache } from "../src/server/directory/coverage";
import { loadActiveAmbulances, loadActiveClinics } from "../src/server/directory/repo";
import { log } from "../src/server/log";
import { resetDb } from "../tests/helpers/db";
import { seedDirectory } from "../tests/helpers/fixtures";
import type { StructuredReply, TurnInput, TurnResult } from "../src/server/agent/types";
import type { Language } from "../src/server/types";

/**
 * One scripted backend call. The lookup keys run those tools first, as the model would. In `reply`, {{AMB:<label>}} and
 * {{CLINIC:<label>}} name a fixture unit or clinic by its label and become the handle a lookup issued for it (in this
 * turn or an earlier one); a label no lookup issued stays as written, so the reply drops it like an invented handle.
 */
interface FakeReply extends Partial<StructuredReply> {
  find_ambulances?: { city?: string | null; area?: string | null; query: string };
  find_clinics?: { city?: string | null };
  get_info?: { topic: InfoTopic };
}

interface Step {
  send?: string;
  send_burst?: string[];
  send_kind?: "audio" | "location";
  place?: string;
  expect?: StepExpect;
}
interface Scenario {
  name: string;
  safety?: boolean;
  language?: Language | null;
  first_contact?: boolean;
  /** "fake": always the scripted backend. "claude": its assertions need the real model, so a fake run skips it. */
  backend?: "fake" | "claude";
  /** The fake backend's script, one reply per backend call (the last repeats); a claude run ignores it. */
  fake_replies?: FakeReply[];
  pause_claude?: boolean;
  steps: Step[];
}
interface Result {
  name: string;
  safety: boolean;
  status: "PASS" | "FAIL" | "SKIP";
  failures: string[];
  latencies: number[];
}

const args = process.argv.slice(2);

function usage(problem: string): never {
  console.error(`${problem}\nUsage: npm run eval [-- --only <name>] [--backend fake|claude] [--allow-db]`);
  process.exit(2);
}

/** The value after `name`, or null when the flag is absent. */
function flag(name: string): string | null {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) usage(`${name} needs a value`);
  return value;
}

const only = flag("--only");
const backendFlag = flag("--backend") ?? "fake";
if (backendFlag !== "fake" && backendFlag !== "claude") usage(`Unknown backend "${backendFlag}"`);
/** The real Claude spends the owner's Max usage, so it runs only when asked for by name. */
const useClaude = backendFlag === "claude";

// Config is read on first use, after this block. log.ts read LOG_LEVEL when it was imported, so its level is set here.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://arham:arham@127.0.0.1:5439/arham_test";
process.env.LOG_LEVEL ??= "warn";
log.level = process.env.LOG_LEVEL;
// The fixture helpline the scenarios expect, and an Interakt key that cannot send: eval conversations are test ones,
// which are never sent, and nothing here may ever reach a real phone.
process.env.HELPLINE_PHONE = "+919999900000";
process.env.INTERAKT_API_KEY = "eval-never-sends";
process.env.ADMIN_PASSWORD ??= "eval-only";
process.env.SESSION_SECRET ??= "eval-only-session-secret-of-32-chars";
process.env.LLM_BACKEND = useClaude ? "claude-code" : "fake";
if (!useClaude) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
resetConfigForTests();

/** The database a connection URL names, or null when it names none or does not parse. */
function databaseName(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1)) || null;
  } catch {
    return null;
  }
}

// Every scenario truncates every table, so only a test database, unless the caller insists.
const dbName = databaseName(process.env.DATABASE_URL);
if (!dbName?.endsWith("_test") && !args.includes("--allow-db")) {
  console.error(
    `Refusing to run: the eval truncates every table, and ${dbName ? `database "${dbName}"` : "TEST_DATABASE_URL"} is not a test database (its name must end in _test). ` +
      "Point TEST_DATABASE_URL at one, or pass --allow-db to run against it anyway."
  );
  process.exit(2);
}

type Labels = Record<"AMB" | "CLINIC", Map<string, string>>;
/** A fixture label in a scripted reply: {{AMB:Mumbai - Ghatkopar}}, {{CLINIC:Arham Clinic Surat}}. */
const LABEL_TOKEN_RE = /\{\{(AMB|CLINIC):([^{}]+)\}\}/g;

/** A FakeBackend step for one scripted reply: its lookups against the turn's tool context, then the reply. */
function fakeStep(r: FakeReply, labels: Labels) {
  const { find_ambulances, find_clinics, get_info, ...structured } = r;
  return async (input: TurnInput): Promise<TurnResult> => {
    const ctx = input.toolContext;
    if (!ctx) throw new Error("the fake backend got no tool context");
    if (find_ambulances) await findAmbulancesImpl(ctx, find_ambulances);
    if (find_clinics) await findClinicsImpl(ctx, find_clinics);
    if (get_info) getInfoImpl(ctx, get_info);
    const issued = Object.entries(ctx.registry.toJSON());
    const reply = (structured.reply ?? "").replace(LABEL_TOKEN_RE, (raw, kind: "AMB" | "CLINIC", label: string) => {
      const id = labels[kind].get(label.trim());
      const handleKind = kind === "AMB" ? "ambulance" : "clinic";
      const handle = issued.find(([, ref]) => ref.kind === handleKind && ref.id === id)?.[0];
      return handle ? `{{${kind}:${handle}}}` : raw;
    });
    return okReply({ ...structured, reply });
  };
}

async function runScenario(s: Scenario) {
  await stopBoss();
  await resetDb();
  resetCoverageCache();
  await seedDirectory();
  await clearClaudePause();
  if (s.pause_claude) await pauseClaude(new Date(Date.now() + 3_600_000), "eval");
  const units = await loadActiveAmbulances();
  const clinicRows = await loadActiveClinics();
  const knownNumbers = new Map(units.map((a) => [a.label, a.phone]));
  for (const c of clinicRows) knownNumbers.set(c.label, c.phone);
  // Every number the bot may send: the directory's, the helpline and the static content's.
  const allNumbers = [...knownNumbers.values(), getConfig().helplinePhone, ...Object.values(getStaticPhones())];
  const labels: Labels = { AMB: new Map(units.map((a) => [a.label, a.id])), CLINIC: new Map(clinicRows.map((c) => [c.label, c.id])) };

  const backend = s.backend === "fake" || !useClaude
    ? new FakeBackend((s.fake_replies ?? []).map((r) => fakeStep(r, labels)))
    : getBackend();

  const [conv] = await getDb()
    .insert(conversations)
    .values({ phone: `+91TEST_eval_${Math.random().toString(36).slice(2, 8)}`, isTest: true, language: s.language ?? null, welcomedAt: s.first_contact ? null : new Date() })
    .returning();

  const failures: string[] = [];
  const latencies: number[] = [];
  for (const [i, step] of s.steps.entries()) {
    const before = (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conv.id))).length;
    const texts = step.send_burst ?? (step.send !== undefined ? [step.send] : step.send_kind ? [""] : []);
    for (const t of texts) {
      await storeReporterMessage(conv.id, step.send_kind === "audio"
        ? { kind: "audio", content: "", mediaUrl: "https://example.invalid/a.ogg" }
        : step.send_kind === "location"
          ? { kind: "location", content: step.place ?? "", placeLabel: step.place ?? null, lat: 18.5, lng: 73.8 }
          : { kind: "text", content: t });
    }
    const started = Date.now();
    const outcome = await runTurn(conv.id, { backend });
    latencies.push(Date.now() - started);
    const all = await getDb().select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(asc(messages.createdAt));
    const newAssistant = all.slice(before + texts.length).filter((m) => m.role === "assistant");
    const [row] = await getDb().select().from(conversations).where(eq(conversations.id, conv.id));
    const turnRows = await getDb().select().from(turns).where(eq(turns.conversationId, conv.id)).orderBy(asc(turns.createdAt));
    const lastTurn = turnRows[turnRows.length - 1] ?? null;
    const fails = checkStep(step.expect ?? {}, {
      messages: newAssistant.map((m) => ({ content: m.content })),
      turnStatus: lastTurn?.status ?? null,
      structured: (lastTurn?.structuredOutput as StructuredReply | null) ?? null,
      flagged: row.flagged,
      outcomeKind: outcome.kind,
      knownNumbers,
      allDirectoryNumbers: allNumbers,
    });
    for (const f of fails) failures.push(`step ${i + 1}: ${f}`);
    if (fails.length) failures.push(`step ${i + 1} reply: ${newAssistant.map((m) => m.content).join(" ⏎ ").slice(0, 300)}`);
  }
  return { failures, latencies };
}

function printTable(results: Result[]) {
  const rows = [
    ["scenario", "safety", "result", "turn latency"],
    ...results.map((r) => [r.name, r.safety ? "yes" : "", r.status, r.latencies.length ? `${r.latencies.join(", ")} ms` : "-"]),
  ];
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)));
  console.log("");
  for (const row of rows) console.log(row.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
}

async function main() {
  if (useClaude) console.warn("⚠ --backend claude: every scenario not pinned to the fake backend calls the real Claude and spends the owner's Max usage.");
  await migrate(getDb(), { migrationsFolder: "src/server/db/migrations" });
  const dir = join(process.cwd(), "evals", "scenarios");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  const results: Result[] = [];
  for (const f of files) {
    const s = parseYaml(readFileSync(join(dir, f), "utf8")) as Scenario;
    if (only && s.name !== only) continue;
    process.stdout.write(`▶ ${s.name} … `);
    if (s.backend === "claude" && !useClaude) {
      console.log("SKIP (needs claude)");
      results.push({ name: s.name, safety: !!s.safety, status: "SKIP", failures: [], latencies: [] });
      continue;
    }
    const { failures, latencies } = await runScenario(s);
    const status = failures.length === 0 ? "PASS" : "FAIL";
    results.push({ name: s.name, safety: !!s.safety, status, failures, latencies });
    console.log(status);
    for (const line of failures) console.log(`    ${line}`);
  }
  if (only && results.length === 0) usage(`No scenario named "${only}"`);
  printTable(results);
  const ran = results.filter((r) => r.status !== "SKIP");
  const all = ran.flatMap((r) => r.latencies).sort((a, b) => a - b);
  const pct = (p: number) => (all.length ? all[Math.min(all.length - 1, Math.floor((p / 100) * all.length))] : 0);
  const passed = ran.filter((r) => r.status === "PASS").length;
  const skipped = results.length - ran.length;
  const safetyFailed = ran.filter((r) => r.safety && r.status === "FAIL").length;
  console.log(
    `\n${passed}/${ran.length} scenarios passed${skipped ? ` · ${skipped} skipped (need claude)` : ""} · safety failures: ${safetyFailed} · turn latency P50 ${pct(50)} ms, P95 ${pct(95)} ms`
  );
  await stopBoss();
  await closeDb();
  process.exit(passed === ran.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
