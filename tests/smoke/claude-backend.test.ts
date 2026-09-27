import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { ClaudeCodeBackend } from "@/server/agent/claude-code-backend";
import { HandleRegistry } from "@/server/agent/handles";
import { createArhamTools, type ToolContext } from "@/server/agent/tools";
import { buildSystemPrompt, buildTurnPrompt, formatIst } from "@/server/agent/prompt";
import { getCoverageSummary, resetCoverageCache } from "@/server/directory/coverage";

// Spends the owner's Max usage, so it runs only on purpose: from a terminal that is not itself inside Claude Code, with
// the owner's token in the environment,
//   RUN_CLAUDE_SMOKE=1 CLAUDE_CODE_OAUTH_TOKEN=<token from `claude setup-token`> npx vitest run tests/smoke
// (tests/setup.ts keeps the token only for such a run). It is also the check that the StructuredOutput tool still
// returns the reply under permissionMode "dontAsk".
const run = process.env.RUN_CLAUDE_SMOKE === "1" ? describe : describe.skip;

run("ClaudeCodeBackend smoke (spends Max usage)", () => {
  beforeEach(async () => { await resetDb(); resetCoverageCache(); await seedDirectory(); });

  it("answers a Ghatkopar request with a token and Hinglish", async () => {
    const ctx: ToolContext = { conversationId: "smoke", language: "hi", registry: new HandleRegistry("smoke"), calls: [], lastAmbulanceCandidates: null, lastAmbulanceMatch: null };
    const { server, allowedToolNames } = createArhamTools(ctx);
    const backend = new ClaudeCodeBackend({
      model: "claude-sonnet-5", effort: "medium", maxTurns: 6, oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN, homeDir: "/tmp/arham-claude-home-test",
      allowExtraUsage: false,
    });
    const res = await backend.runTurn({
      conversationId: "smoke",
      systemPrompt: buildSystemPrompt({ coverage: await getCoverageSummary(), websiteUrl: "https://alwayscare.org" }),
      prompt: buildTurnPrompt({ nowIst: formatIst(new Date()), language: null, knownLocation: null, handlesShared: [], welcomeJustSent: true, correction: null,
        transcript: "--- NEW MESSAGES (answer these) ---\n[10:03] Reporter: ghatkopar station ke paas kutta ghayal hai please jaldi" }),
      toolServer: server, allowedToolNames, timeoutMs: 60_000,
    });
    // toMatchObject, so a failed turn prints its kind and message.
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) return;
    expect(res.structured.intent).toBe("ambulance");
    expect(res.structured.reply).toMatch(/\{\{AMB:amb_[a-p]{8}\}\}/);
    expect(res.structured.reply).not.toMatch(/\d{7,}/);
    expect(ctx.calls.some((c) => c.name === "find_ambulances")).toBe(true);
  }, 90_000);
});
