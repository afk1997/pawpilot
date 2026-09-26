# Arham Always Care — WhatsApp Helpline Bot (V2)

Question-and-answer WhatsApp helpline for Arham Always Care, the animal-rescue project of Arham Yuva Seva Group. People ask for the animal-ambulance number for their area, clinic details, or how to donate or volunteer. The bot answers in English, Hindi, Marathi or Gujarati from the directory. It is not a dispatcher: there is no escalation queue, no follow-ups, no cron jobs. Arham runs most ambulances and partner NGOs run the rest; code labels a partner unit's number with its operator ("(operated by <partner>)", in the reply's language). **Life-and-death software: be conservative.**

Design spec: `docs/superpowers/specs/2026-09-25-v2-qa-helpline-design.md`. Implementation plan: `docs/superpowers/plans/2026-09-25-v2-core-bot.md`. Where the spec and the code differ, the code is right (see "Spec drift"). Setup and operations: `README.md`.

## Hard rules

1. **The model never types phone digits.** Tools return opaque handles; the reply carries `{{AMB:handle}}`, `{{CLINIC:handle}}` or `{{PHONE:helpline}}` tokens (or a `{{PHONE:<key>}}` that `get_info` returned for a number in `src/content/static.json`); `src/server/agent/render.ts` substitutes real numbers; `src/server/agent/scrub.ts` strips any other 7+ digit run after one corrective retry. The public 102/108/112 emergency numbers are the only ones the prompt lets the model write.
2. **No dispatching language.** We hand over a number; the reporter calls. The dispatch guard asks for one corrected draft, then replaces offending sentences with the localized "Please call them directly and they will guide you.", keeping any number they held.
3. **Time to number is the metric.** When Claude is paused or fails, `src/server/worker/fallback.ts` still sends a directory card or the helpline number.
4. **Multilingual.** en / hi / mr / gu everywhere: cards, welcome and menu, fallback and system lines. Claude replies in the reporter's language and script; Latin-script Hinglish counts as `en` for the system's own lines.
5. **Idempotent ingress.** Dedup by Interakt message id; one turn per conversation at a time (pg-boss singleton + advisory lock).
6. **Visible degradation.** Every failure is a `turns` row, an `events` row, a conversation flag or a health-endpoint signal. Nothing fails silently.
7. **Test conversations never reach Interakt** (`is_test`, phones `+91TEST_…`).

## Architecture

Interakt → `POST /api/webhook` (verify, dedup, store, enqueue) → Postgres + pg-boss `turn` queue → worker (`src/server/worker`) → Claude Sonnet 5 via `@anthropic-ai/claude-agent-sdk` (pinned 0.3.282, which bundles Claude Code CLI 2.1.282) under the owner's Max plan (`CLAUDE_CODE_OAUTH_TOKEN`) with three in-process tools → render + scrub → Interakt send. Admin at `/admin` (password cookie) with transcripts and turn details; test harness at `/test-chat`; health at `/api/health`.

## Claude backend (`src/server/agent/claude-code-backend.ts`)

The CLI runs locked down. Do not loosen any of this without the owner:

- `tools: []`, with the built-in tool names and `mcp__claude_ai_*` also in `disallowedTools`: no shell, file or web tools. The model has only the three `mcp__arham__*` tools and the CLI's `StructuredOutput`, which carries the reply.
- `permissionMode: "dontAsk"`: a tool call `allowedTools` does not pre-approve is denied without a prompt. Not `bypassPermissions`, which the CLI refuses to run as root.
- `strictMcpConfig: true` (and `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the child env): only the in-process `arham` server loads; no user, project or claude.ai connector servers.
- `verbatimPrompts: true`: reporter text is part of the prompt, so an `@path` mention in it must never be expanded into a file read (`/proc/<pid>/environ`, say) and a `/command` never run. `src/server/agent/transcript.ts` also rewrites an `@` before a path, as a second layer.
- An env allowlist (`buildChildEnv`; the SDK does not merge `env` with `process.env`): PATH, locale, TZ, TMPDIR, CA and proxy variables, HOME set to `LLM_HOME_DIR` with the config dir inside it, and the OAuth token. The database URL, Interakt key, admin secrets and a parent Claude Code session's variables never reach the child. Because HOME and the config dir are its own, a `claude login` made on the machine is not seen either: the worker needs `CLAUDE_CODE_OAUTH_TOKEN`.
- `settingSources: []`, `persistSession: false`, `cwd` = `LLM_HOME_DIR`: no user or project settings or CLAUDE.md are loaded, and no session transcript is saved.
- The init check is strict: the init message must list the three arham tools and nothing else but `StructuredOutput`, with `arham` connected, or the turn aborts as TRANSIENT (`mcp_not_connected: …` in the turn's error) and falls back. A CLI that changes that list sends every turn to the fallback.

The owner's smoke run is the go-live gate, and must be re-run after any `@anthropic-ai/claude-agent-sdk` upgrade: `RUN_CLAUDE_SMOKE=1 npx vitest run tests/smoke`, from a terminal outside Claude Code, with `CLAUDE_CODE_OAUTH_TOKEN` exported in that shell (README, "Go-live gate"). It is also the only check that `StructuredOutput` returns the reply under `dontAsk` against the real API.

Failure classes: LIMITED and AUTH pause Claude for every conversation (`worker_state`); INVALID_OUTPUT, and a TRANSIENT failure that was not a timeout, get one retry inside the turn's 100 s budget; whatever still fails goes to the fallback.

## Guard residuals (known gaps, not bugs to rediscover)

- The reply scrubber reads a run as digits joined by at most one space, line break or hyphen. It misses dotted or spaced-dash groups ("98765.43210", "98765 - 43210"), runs of several dash characters ("98765--43210"), slashes, commas, brackets, and a number split across sentences or lines. The tool-output scrub has the same separator gaps. Full list: the `DIGIT_RUN_RE` comment in `src/server/agent/scrub.ts`.
- The dispatch guard has no Latin-script Hinglish vocabulary yet ("ambulance bhej rahe hain" and "gaadi aa rahi hai" pass); adding it waits for an eval pass on the real model. Its Indic "is coming" and "on the way" rules fire only with an ambulance or team word right before the phrase (precision first).
- The tool-boundary scrub (`scrubToolText` in `src/server/agent/tools.ts`) removes every phone-shaped run from what a tool returns before the model sees it, so the model cannot relay a non-phone number from the directory.
- `src/content/static.json` is tokenized at load instead: every 7+ digit run in it becomes a `{{PHONE:<key>}}` token and goes out formatted as a phone number. `donate.bank` and `donate.upi` are still TODO, so `get_info` omits them and the bot gives the donate URL. Filled with an account number, IFSC or digit UPI id, they would reach the reporter mangled ("A/c +50100123456789"): keep bank and UPI details on the website, or add a non-phone token type first.

## Spec drift (the code is right)

- Env names: `LLM_BACKEND`, `LLM_MODEL`, `LLM_EFFORT`, `LLM_MAX_TURNS`, `LLM_TURN_TIMEOUT_MS`, `LLM_HOME_DIR`, `LLM_TOKEN_ISSUED_AT`, plus `CLAUDE_CODE_OAUTH_TOKEN` (`src/server/config.ts`). The spec's other `CLAUDE_*` names do not exist, and its deployment, geocoding and backup variables (`POSTGRES_PASSWORD`, `PUBLIC_HOSTNAME`, `ACME_EMAIL`, `NOMINATIM_*`, `GOOGLE_GEOCODING_API_KEY`, `AZURE_BACKUP_SAS_URL`) are not read yet.
- §5.4: `permissionMode` is `dontAsk`, not `bypassPermissions`; HOME, config dir and cwd all come from `LLM_HOME_DIR`.
- §5.12: `src/server/interakt/client.ts` sends two payloads only. Each is a `POST` to `INTERAKT_API_BASE` with `Authorization: Basic <INTERAKT_API_KEY>` and a 15 s timeout, carrying `{ countryCode, phoneNumber, callbackData: "agent" }` plus:
  - `Text`: `type: "Text", data: { message: <text> }`;
  - `InteractiveList`: `type: "InteractiveList", data: { message: { type: "list", body: { text }, action: { button, sections: [{ title, rows: [{ id, title, description? }] }] } } }`.

  There is no Template payload (none is kept for later) and no admin reply box. A number starting with "+" is split by the ITU country-code table; bare numbers follow the India rules in `splitPhone`. `+91TEST_` phones are refused.
- §5.7: handles are `amb_`/`cli_` plus eight letters a–p, so a handle never holds a digit.
- §5.2: turn jobs expire after 240 s, above the Claude turn's 100 s budget.
- §5.10: the fallback gives a unit's number only for an exact area or city match with one to three units; anything looser gets the helpline card.
- §5.15: there is no middleware; each admin and test-chat page and API route checks the cookie itself. The admin page is read-only and polls.

## Working here

- Local: `docker compose -f docker/docker-compose.dev.yml up -d`, `npm run migrate`, `npm run ingest:ambulances`, `npm run dev` and `npm run worker:dev`. `LLM_BACKEND=fake` gives canned replies without Claude (refused when `NODE_ENV=production`).
- Tests: `npm run test:unit` (`tests/unit`) and `npm test` (everything) both need the dev Postgres, because the global setup migrates `arham_test` first. The smoke test is skipped unless `RUN_CLAUDE_SMOKE=1`, and `tests/setup.ts` drops `CLAUDE_CODE_OAUTH_TOKEN` from every other run.
- Evals: `npm run eval` uses the scripted fake backend by default and skips the five scenarios that need the real model; `npm run eval -- --backend claude` spends Max usage. The runner uses `TEST_DATABASE_URL` and refuses a database whose name does not end in `_test`, since it truncates every table.
- Anything that spends Max usage (the smoke test, `--backend claude` evals, a worker with `LLM_BACKEND=claude-code`) is started by the owner from a terminal outside Claude Code, never from an agent session.
- Change the prompt (`src/server/agent/prompt.ts`) only with the eval suite green on the real model (`-- --backend claude`); the fake backend never reads the prompt.
- Before committing: `npm run typecheck && npm run lint && npm test`. History is never squashed; PRs merge with a merge commit.
- `ambulances-clinics.csv` is gitignored (driver personal numbers). `.codex/`, `.mcp.json` and the `.env` files (all but `.env.example`) are gitignored.
