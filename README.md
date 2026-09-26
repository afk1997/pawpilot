# Arham Always Care WhatsApp helpline

Q&A helpline bot on WhatsApp (Interakt) for Arham Always Care. Reporters ask for the animal-ambulance number for their area, clinic details, donations or volunteering; the bot answers in English, Hindi, Marathi or Gujarati from the directory. Phone numbers are always inserted by code, never typed by the model (the public 102/108/112 emergency numbers excepted). The bot hands over a number and the reporter calls; it never dispatches.

Project instructions for coding agents, the Claude backend's safety settings and the known gaps in the guards: `CLAUDE.md`.

## Stack

Next.js 16 (webhook, admin, test chat), a separate Node worker, Postgres 17, pg-boss queue, Claude Sonnet 5 through the Claude Agent SDK (pinned 0.3.282) on the owner's Max plan. Docker Compose runs the dev Postgres; the production image, Caddy and the Azure VM come with the follow-up plan.

## Local development

1. `cp .env.example .env.local` and fill in the Interakt keys, `HELPLINE_PHONE`, `ADMIN_PASSWORD` and `SESSION_SECRET`. For Claude, run `claude setup-token` and set `CLAUDE_CODE_OAUTH_TOKEN`. The token is required: the worker runs the Claude CLI with `LLM_HOME_DIR` as its HOME, so a `claude login` on this machine is never seen. For UI work without Claude, set `LLM_BACKEND=fake`.
2. `docker compose -f docker/docker-compose.dev.yml up -d` (Postgres 17 on 127.0.0.1:5439 with the `arham` and `arham_test` databases).
3. `npm install && npm run migrate`
4. Put the directory spreadsheet at `ambulances-clinics.csv` and run `npm run ingest:ambulances`.
5. Terminal A: `npm run dev`. Terminal B: `npm run worker:dev`.
6. Open http://localhost:3000/admin, log in, then http://localhost:3000/test-chat to talk to the bot.

Next.js loads `.env.local` for the app. The worker, `migrate`, `ingest:ambulances` and `eval` load `.env.local` and then `.env` themselves, and a variable already set in the shell wins. Tests read only the shell environment.

With `LLM_BACKEND=claude-code` (the default), test-chat messages get real Claude turns on the owner's Max plan, so start that worker from a terminal outside Claude Code.

Ctrl-C under `npm run worker:dev` delivers SIGINT twice (the terminal's, and the copy tsx forwards); the worker shuts down once and ignores the second. This happens only in development.

For real WhatsApp traffic locally, expose port 3000 (e.g. ngrok) and point the Interakt webhook at `/api/webhook` with the same `INTERAKT_WEBHOOK_SECRET`.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Next.js dev server on port 3000 (webhook, admin, test chat) |
| `npm run build` | production build of the Next.js app |
| `npm run start` | serve that build |
| `npm run worker` | run the worker (production; TypeScript through tsx, no build step) |
| `npm run worker:dev` | the worker under `tsx watch`, restarted on file changes |
| `npm run db:generate` | generate a migration after editing `src/server/db/schema.ts` |
| `npm run migrate` | apply migrations to `DATABASE_URL` (neither the app nor the worker migrates at start) |
| `npm run ingest:ambulances` | load `ambulances-clinics.csv` (or the path given after `--`) into `DATABASE_URL` |
| `npm run eval` | the 27 conversation scenarios on the scripted fake backend, skipping the 3 that need the real model; `-- --backend claude` runs them on Claude and spends Max usage; `-- --only <name>` runs the one whose YAML `name:` matches. Every scenario file is checked against a strict schema first, and an unknown key fails the run. Uses `TEST_DATABASE_URL`; since it truncates every table, it refuses (exit 2) unless the database it connects to is named `*_test` (`-- --allow-db` overrides). Exits 1 when any scenario fails |
| `npm test` | all tests (needs the dev Postgres; uses the `arham_test` database; the Claude smoke test is skipped) |
| `npm run test:unit` | `tests/unit` only (still needs the dev Postgres: the global setup migrates `arham_test`) |
| `npm run test:watch` | vitest in watch mode |
| `npm run lint` | eslint |
| `npm run typecheck` | `tsc --noEmit` |

## How a message flows

1. Interakt calls `POST /api/webhook`; the app verifies the HMAC, dedups by message id, stores the message and enqueues a `turn` job (messages a couple of seconds apart become one turn). No LLM work happens here.
2. The worker picks the job (one per conversation at a time), gathers every unanswered message, and either sends the welcome menu, the menu, the "please type" line for voice notes, or runs a Claude turn. On first contact the welcome goes out first, and a burst of only greetings stops there.
3. Claude gets the coverage list, the transcript and three tools that return handles instead of numbers. Its structured reply contains tokens; code substitutes the real numbers and partner labels. Stray digits and dispatch language each get one corrective retry, then are stripped or replaced. The reply goes out via Interakt and a `turns` row records the turn.
4. If Claude is paused (usage limit, auth problem) or fails, the fallback path answers from the directory alone and flags the conversation.

## Operations

- `/api/health` (no login, no personal data) returns 200 when the environment is valid (`checks.config`), the database is up, the worker heartbeated within 2 minutes and not ahead of the app's clock (`checks.clockSkew`), no auth error happened in the last hour and replies are getting out; otherwise 503. `checks.delivery` is `degraded` when the last five finished sends to real conversations all failed within 15 minutes, or when a reporter message has waited over 10 minutes with nothing delivered since it came (a first message after a quiet spell is not an outage); `checks.lastDeliveredAgeS` is the age of the last send Interakt accepted. It also reports the Claude pause state and reason, the age of the last good turn, days left on the token and the `turn` queue counts.
- **Pauses.** A usage limit (LIMITED) pauses Claude for every conversation until the reset time Claude reports, or for 15 minutes; an auth problem (AUTH) pauses it for 15 minutes and records a `claude_auth_error` event, which turns health red for an hour. While paused, turns go straight to the fallback.
- **Extra usage** is off: `LLM_ALLOW_EXTRA_USAGE` defaults to `false` (the owner's decision), and the owner keeps extra usage off in the Claude account too. If a turn reaches the plan's limit and extra usage pays for it anyway, the reply that came back is still delivered; the turn makes no further call, then pauses Claude until the reset (15 minutes when no reset time comes) and records a `claude_limited` event with `extraUsage: true`, and the fallback answers until then. Every turn extra usage paid for also records a `claude_extra_usage` event, carries `extraUsage: true` in its `usage` (admin turn details) and is logged as `claude turn used extra usage` at warn. `LLM_ALLOW_EXTRA_USAGE=true` lets such turns run on extra usage without the pause.
- **Token.** The Claude token lasts one year: rerun `claude setup-token`, update `CLAUDE_CODE_OAUTH_TOKEN` and `LLM_TOKEN_ISSUED_AT`, restart the worker. `LLM_TOKEN_ISSUED_AT` lets the health endpoint count down (`tokenDaysLeft`); the countdown never fails the check.
- **Directory.** Edit the spreadsheet and re-run `npm run ingest:ambulances`. It checks every row first and writes nothing if one fails, adds or updates units and clinics by Name, and deactivates those the file no longer lists. Lookups see the change at once; the coverage list in Claude's prompt refreshes within an hour (restart the worker to refresh it now).
- **Sweep.** The worker heartbeats every 30 s and, every minute, re-queues conversations with a reporter message unanswered for over 15 s (up to 6 h old). After three failed turns in an hour it flags the conversation `turn_failed` instead.
- **Resends.** In the same minute, a reply whose send failed with a retryable status (no response, 429 or 5xx) is sent again from its stored text, never a new model call: at most three attempts in all, only while the reply is under 10 minutes old. The row keeps the latest status (`delivery_status`, `delivery_http_status`, `delivery_attempts`, `error`) and each attempt is an `outbound_retry` event. A refused send (a 4xx, say) is not retried; the conversation keeps its `send_failed` flag.

### Go-live gate: the owner's smoke run

Before going live, and again after any `@anthropic-ai/claude-agent-sdk` upgrade, the owner runs the one test that calls the real Claude. Run it from a terminal outside Claude Code, with the dev Postgres up (vitest does not read `.env.local`, hence the export):

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<token from claude setup-token>
RUN_CLAUDE_SMOKE=1 npx vitest run tests/smoke
```

It must pass: a Hinglish Ghatkopar request comes back as an ambulance reply with an `{{AMB:…}}` token, no typed digits, and a `find_ambulances` call. That proves the three tools connect and that `StructuredOutput` returns the reply under the backend's `dontAsk` permission mode. The backend's init check is strict (the three arham tools and nothing else but `StructuredOutput`), so a new CLI that lists another tool would send every turn to the fallback; this run catches that before deploy. It spends a little Max usage.

## Admin and test chat

- `/admin/login` takes `ADMIN_PASSWORD` and sets a 30-day `arham_admin` cookie (HttpOnly, SameSite=Lax, Secure in production). Its signing key is derived from both `SESSION_SECRET` and `ADMIN_PASSWORD`, so changing either logs everyone out; that is the only way to revoke sessions.
- Logout is `DELETE /api/admin/login`, which clears the cookie. There is no button yet; from the browser console: `fetch("/api/admin/login", { method: "DELETE" })`.
- Login allows 5 failures per client address per 15 minutes, and 50 across all addresses. The address is the first entry of the proxy-supplied `X-Forwarded-For` header (without one, every client shares the bucket `unknown`), and the counts live in the app's memory.
- `/admin` lists conversations (filters all, flagged, human, test; search by phone or name) and shows each transcript with its turns: status, model, latency, intent, location, notes, error, tool calls, usage and the scrub flag.
- Flags: `claude_unavailable` (the fallback answered), `needs_human` (Claude set it: the reporter wants a person, cannot reach a driver, or the bot cannot help), `send_failed` (Interakt refused a send) or `turn_failed` (see Sweep). The first reason sticks, and flags can be cleared only in the database for now.
- `/test-chat` (same login) creates `is_test` conversations with `+91TEST_…` phones that go through the real queue and worker; their replies are stored with `delivery_status = test_skipped` and never reach Interakt.

## Static content

`src/content/static.json` holds the donate, volunteer, about, FAQ and human-emergency text in four languages. A `TODO` value is dropped, and English stands in for a missing translation. Most translations, the UPI id, the bank details and the volunteer contact are still `TODO`. Its links, like the `WEBSITE_URL` default the welcome, the menu and the prompt use, point to the owner's website, https://alwayscare.org; the bot itself is served from helpline.arhamalwayscare.org.

In `donate` and `volunteer`, only a field whose name says it holds a phone (`phone`, `contact`, `mobile`, `helpline`, `whatsapp` or `number` in the name, such as `contact_phone`) has its number turned into a `{{PHONE:…}}` token when the file loads; when Claude copies that token into a reply it goes out formatted as a phone number. A number in any other field (`bank`, `upi`, `summary`) is left as written, and the tool-boundary scrub removes it before the model sees it, so an account number, IFSC code or digit UPI id can never be relayed: keep bank and UPI details on the website, and the bot gives the donate URL (a non-phone `{{ACCOUNT:…}}` token is a possible follow-up). In the free text of `about`, `human_emergency` and the FAQ, every run of 7+ digits is still read as a phone number (the FAQ's Animal Helpline India number relies on it), so only phone numbers belong there. Every other tool output (a directory address, say) has its phone-shaped runs removed before the model sees it, so those cannot be relayed either.

## Deploy notes for the follow-up plan

The production image, Caddy, Azure VM, backups, deploy script and uptime monitor come with the follow-up plan (not written yet). What the code already requires of them:

- Run the worker container as a non-root user (the backend logs a warning when it runs as root), with a writable `LLM_HOME_DIR` it owns; the backend keeps that directory at mode 0700.
- Set the worker's `stop_grace_period` above 145 s (say `160s`) and start it with an exec-form CMD that runs node itself (e.g. `["node", "--import", "tsx", "src/server/worker/index.ts"]`), so SIGTERM reaches node. On SIGTERM the worker stops taking jobs and gives in-flight turns up to 145 s (`GRACEFUL_STOP_MS` in `src/server/worker/start.ts`: a turn's 100 s budget, its 15 s Interakt send and a 30 s margin); Docker's default 10 s would kill a turn in progress, and a turn cut off after its send can be retried and reach the reporter twice.
- `npm run worker` and `migrate` run TypeScript through tsx and load `.env` files with dotenv, both devDependencies (`ingest:ambulances` also needs csv-parse): install dev dependencies in the image, or move those packages to dependencies.
- Caddy must overwrite `X-Forwarded-For` with the client's bare address (no port, no client-supplied chain), since the login limiter keys on its first entry.
- Run `npm run migrate` before starting new code; neither the app nor the worker migrates at start.
- Set `NODE_ENV=production` for the worker too (`next start` defaults it for the app). In production the config refuses `LLM_BACKEND=fake`, `INTERAKT_WEBHOOK_VERIFY_MODE=off` and an empty `INTERAKT_WEBHOOK_SECRET` (the process will not start), the admin cookie is Secure and `LOG_RAW_WEBHOOKS` is ignored.
- Keep Postgres on the same host. If it ever moves off-host, lower its `tcp_keepalives_idle`: each turn holds a session advisory lock on its own connection, and a worker host that vanishes without closing it blocks that conversation until Postgres notices the dead peer (about two hours with the Linux default).

## Known limitations

- Voice notes are not transcribed: a burst of only voice notes gets a localized "please type" line, and in a mixed burst Claude sees `[voice note received — not transcribed]`.
- Photos, videos, documents and stickers are stored (Interakt's media URL) and acknowledged, never analysed.
- Location pins carry only the name and address WhatsApp attaches. Reverse geocoding is in the follow-up plan, so for a bare pin Claude asks for the area and city.
- The admin page is read-only: no take-over toggle, reply box, clear-flag button or SSE live updates (it polls every few seconds). Take-over and SSE are in the follow-up plan; `mode = human` can be set only in the database today.
- No production Docker image, Caddy, Azure rollout, backups or uptime monitor yet: all in the follow-up plan.
- The test chat caps a message at 2000 characters counted in UTF-16 units: each Indic vowel sign or virama counts on its own, and most emoji count as two.
- The digit scrubber and the dispatch guard have known gaps (dotted or spaced-dash digit groups, runs of several dashes, Latin-script Hinglish dispatch wording): see "Guard residuals" in `CLAUDE.md`.
- Replies are written ahead: each is stored as `sending`, with the reporter messages it answers marked, before Interakt is called, so a crash or a failed write after the send never makes a retried job answer the burst again. If the worker dies between a send and recording its outcome, the row stays `sending` and the resend sweep sends the same text again after 2 minutes: the reporter may get that reply twice, never a different one.
- The `InteractiveList` payload has not been checked against the live Interakt API. If Interakt rejects it, the plain-text welcome or menu goes out instead and a `list_send_failed` event is recorded.
