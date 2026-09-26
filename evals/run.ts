import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config as loadEnv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { asc, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { checkStep } from "./assertions";
import {
  UsageError, allowedNumbersFor, databaseName, databaseRefusal, fakeStep, formatTable, modelReplyOf, needsClaude, parseArgs,
  summarize, summaryLine, type Directory, type EvalArgs, type Labels, type Scenario, type ScenarioResult,
} from "./lib";
import { getConfig, resetConfigForTests } from "../src/server/config";
import { getDb, getSql, closeDb } from "../src/server/db/client";
import { conversations, messages, turns } from "../src/server/db/schema";
import { storeReporterMessage } from "../src/server/inbound/store";
import { runTurn } from "../src/server/worker/turn-runner";
import { pauseClaude, clearClaudePause } from "../src/server/worker/pause";
import { stopBoss } from "../src/server/queue/boss";
import { getBackend } from "../src/server/agent";
import { FakeBackend } from "../src/server/agent/fake-backend";
import { getStaticPhones } from "../src/server/content/static";
import { resetCoverageCache } from "../src/server/directory/coverage";
import { loadActiveAmbulances, loadActiveClinics } from "../src/server/directory/repo";
import { log } from "../src/server/log";
import { resetDb } from "../tests/helpers/db";
import { seedDirectory } from "../tests/helpers/fixtures";

function usage(problem: string): never {
  console.error(`${problem}\nUsage: npm run eval [-- --only <name>] [--backend fake|claude] [--allow-db]`);
  process.exit(2);
}

function readArgs(): EvalArgs {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof UsageError) usage(e.message);
    throw e;
  }
}

const args = readArgs();
/** The real Claude spends the owner's Max usage, so it runs only when asked for by name. */
const useClaude = args.backend === "claude";

// Config is read on first use, after this block. log.ts read LOG_LEVEL when it was imported, so its level is set here:
// errors only by default, since every failure the runner judges is in its own output.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://arham:arham@127.0.0.1:5439/arham_test";
process.env.LOG_LEVEL ??= "error";
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

// Every scenario truncates every table: a URL naming another database is refused before any connection. main checks
// the database actually connected to as well, since the URL's query string can override its path.
const urlDatabase = databaseName(process.env.DATABASE_URL);
const urlRefusal = databaseRefusal(urlDatabase, args.allowDb);
if (urlRefusal) {
  console.error(urlRefusal);
  process.exit(2);
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
  const directory: Directory = {
    ambulances: new Map(units.map((a) => [a.id, a.phone])),
    clinics: new Map(clinicRows.map((c) => [c.id, c.phone])),
  };
  const always = [getConfig().helplinePhone, ...Object.values(getStaticPhones())];
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
    // The turn this step's runTurn reported, never another step's.
    const [turn = null] = outcome.turnId ? await getDb().select().from(turns).where(eq(turns.id, outcome.turnId)) : [];
    const fails = checkStep(step.expect ?? {}, {
      messages: newAssistant.map((m) => ({ content: m.content })),
      turnStatus: turn?.status ?? null,
      structured: modelReplyOf(turn),
      flagged: row.flagged,
      outcomeKind: outcome.kind,
      knownNumbers,
      allowedNumbers: allowedNumbersFor(turn, directory, always),
    });
    for (const f of fails) failures.push(`step ${i + 1}: ${f}`);
    if (fails.length) failures.push(`step ${i + 1} reply: ${newAssistant.map((m) => m.content).join(" ⏎ ").slice(0, 300)}`);
  }
  return { failures, latencies };
}

async function main() {
  const dir = join(process.cwd(), "evals", "scenarios");
  const scenarios = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => parseYaml(readFileSync(join(dir, f), "utf8")) as Scenario);
  if (args.only && !scenarios.some((s) => s.name === args.only)) usage(`No scenario named "${args.only}"`);
  if (useClaude) console.warn("⚠ --backend claude: every scenario not pinned to the fake backend calls the real Claude and spends the owner's Max usage.");

  const [{ current_database: connected }] = await getSql()<{ current_database: string }[]>`select current_database()`;
  const refusal = databaseRefusal(connected, args.allowDb);
  if (refusal) {
    console.error(connected === urlDatabase ? refusal : `${refusal} (Connected to "${connected}" although the URL's path names "${urlDatabase}".)`);
    await closeDb();
    process.exit(2);
  }
  await migrate(getDb(), { migrationsFolder: "src/server/db/migrations" });

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    if (args.only && s.name !== args.only) continue;
    process.stdout.write(`▶ ${s.name} … `);
    if (needsClaude(s, useClaude)) {
      console.log("SKIP (needs claude)");
      results.push({ name: s.name, safety: !!s.safety, status: "SKIP", failures: [], latencies: [] });
      continue;
    }
    let run: { failures: string[]; latencies: number[] };
    try {
      run = await runScenario(s);
    } catch (e) {
      // A scenario that throws fails on its own: the rest still run and the table still prints.
      run = { failures: [`error: ${e instanceof Error ? e.message : String(e)}`], latencies: [] };
    }
    const status = run.failures.length === 0 ? "PASS" : "FAIL";
    results.push({ name: s.name, safety: !!s.safety, status, ...run });
    console.log(status);
    for (const line of run.failures) console.log(`    ${line}`);
  }

  console.log("");
  for (const line of formatTable(results)) console.log(line);
  const summary = summarize(results);
  console.log(`\n${summaryLine(summary)}`);
  await stopBoss();
  await closeDb();
  process.exit(summary.exitCode);
}

main().catch((e) => { console.error(e); process.exit(1); });
