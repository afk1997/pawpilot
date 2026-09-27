# Arham Always Care WhatsApp Helpline — V2 Design

**Date:** 2026-09-25
**Status:** Draft for review
**Supersedes:** the V1 "dispatcher copilot" design (plan file no longer exists; V1 code in git history is the record)

## 1. Context

V1 was built as a dispatcher copilot: escalation queue, 5-minute follow-ups, closure summaries, Cases and GPS integrations, and an LLM turn driven by a 170-line prompt of prohibitions. The pilot ran on `google/gemma-4-31b-it`, and the result was a bot that repeated its welcome, forgot the location it was just told, escalated on the word "human", and promised follow-ups that never came. Its Supabase project has since been deleted, so the app is dead.

V2 re-scopes the product to what the NGO actually needs: a **question-and-answer helpline**. People message the Arham Always Care WhatsApp number to ask for the animal-ambulance number for their area, for clinic details, or how to donate or volunteer. The bot answers warmly, in their language, from the directory, and never invents a phone number.

### Goals

1. Correct, natural, multilingual answers about ambulances, clinics, donations, volunteering and FAQs.
2. Phone numbers are provably sourced from the directory. The model never types digits.
3. Conversation memory: the bot remembers what it was told earlier in the chat.
4. Runs on one Azure VM the NGO owns, with Postgres, for about $26/month.
5. LLM calls go through the owner's Claude Max plan (owner's decision after being shown Anthropic's guidance; see §3).
6. Quality is measured, not guessed: an eval suite gates every prompt change.

### Non-goals (this round)

- Dispatcher console, escalation queue, notifications to dispatchers.
- Follow-up messages, closure summaries, Cases API, GPS API, cron jobs.
- Voice-note transcription (reply asks the reporter to type; audio URL is logged).
- Photo/video understanding (stored, acknowledged, not analysed).
- Directory editing in the UI (CSV ingest script remains the way).
- Multi-user admin accounts.

### Success criteria

| Criterion | Target |
|---|---|
| Eval suite pass rate before pilot | 100% of safety scenarios, ≥95% overall |
| Digits authored by the model reaching a reporter | 0 (scrubber violations logged, none delivered) |
| Reply latency (turn record, Claude path) | P50 ≤ 10 s, P95 ≤ 20 s |
| Duplicate welcomes on a 3-message burst | 0 |
| Fallback path delivers a directory number with Claude paused | ≤ 5 s |
| V1 pilot failures (Goregaon→Malad, Munbai typo, Bangalore alias, Lucknow out of coverage, thanks loop, "human" false escalation, medicine question) | all covered by evals and passing |

## 2. Scope

**In:** welcome menu on first contact; ambulance lookup by city/area/landmark in English, Hindi (Devanagari and Hinglish), Marathi, Gujarati; clinic lookup; donate/volunteer/about/FAQ content; human-emergency referral; conversation memory; location pins; graceful handling of photos, videos, documents, stickers, voice notes; helpline number as fallback when the bot can't help; no-LLM fallback when Claude is unavailable; password-protected admin page with transcripts, turn details and a per-conversation human take-over; test-chat harness; eval suite; Azure VM deployment with backups and health monitoring.

**Out:** everything listed under non-goals.

## 3. Decisions log

| Decision | Choice | Notes |
|---|---|---|
| LLM access | Owner's Claude Max plan via the Claude Agent SDK (headless Claude Code) | Anthropic's Agent SDK docs say third-party products should use API keys and that subscription tokens are for the subscriber's own scripts; the owner chose Max anyway. The backend sits behind an interface so an API key can be swapped in by env var. A no-LLM fallback keeps number delivery alive when the plan is throttled. |
| Model | `claude-sonnet-5`, effort `medium` | Spike: correct tool use, warm Hinglish reply, ~9 s model time. Opus available by env var. |
| Hosting | One Azure VM, B2pls_v2 (Arm, 2 vCPU / 4 GiB), Central India, plain Postgres 17 in Docker | ~$26/mo incl. disk and IP. If the Agent SDK's bundled CLI misbehaves on arm64, use B2als_v2 (AMD, +$1.6/mo). |
| Escalation | None. Bot hands over the helpline's own number; conversation gets flagged on the admin page | Owner: "no dispatcher". |
| Admin UI | Transcript page + take-over toggle behind one password | |
| Brain design | Claude composes the whole reply with `{{AMB:handle}}` tokens; code substitutes numbers and scrubs | Spike-proven. |
| Voice notes | Deferred | Research: Sarvam Saaras v3 is the best option when added (₹0.50/min); vanilla Whisper is unusable for Marathi/Gujarati. |
| Hostname | `helpline.arhamalwayscare.org` (Namecheap DNS, A record to the VM IP) | |

## 4. Architecture

```
Reporter (WhatsApp)
   │
   ▼
Interakt ── POST https://helpline.arhamalwayscare.org/api/webhook
   │                       │
   │              caddy (TLS) → app (Next.js 16)
   │                       │  verify HMAC · parse · dedup · insert message · enqueue turn · 200
   │                       ▼
   │                  postgres 17  ◄──── pg-boss queue (schema `pgboss`)
   │                       ▲                    │
   │                       │                    ▼
   │                  worker (Node)  ── turn runner ── Claude Agent SDK (Sonnet 5, Max token)
   │                       │              │  in-process tools: find_ambulances · find_clinics · get_info
   │                       │              ▼
   │                       │         render (tokens → numbers) · scrub · send
   └──────────────── Interakt send API ◄──────┘

admin browser ── /admin (password cookie) ── SSE from Postgres NOTIFY
backup container ── nightly pg_dump → Azure Blob
```

Five containers from one image (`app`, `worker`) plus `caddy`, `postgres`, `backup`, orchestrated by Docker Compose on the VM.

### 4.1 Repository layout

```
src/
  app/                       # Next.js routes: /api/webhook, /api/health, /admin, /test-chat, /api/admin/*, /api/test-chat/*
  server/
    db/                      # drizzle schema, client, migrations
    queue/                   # pg-boss bootstrap, job names, send helpers
    worker/                  # entrypoint, turn runner, coalescing, fallback path, heartbeat
    agent/                   # LLMBackend interface, claude-code backend, prompt, output schema, tools, render, scrub
    directory/               # matcher, aliases, neighbours, coverage summary
    interakt/                # send client, webhook parser
    media/                   # reverse geocoding
    content/                 # static.json loader
    lang.ts                  # script detection for welcome + fallback
evals/                       # scenarios/*.yaml, run.ts, judge.ts
scripts/                     # ingest-ambulances.ts, deploy.sh, backup.sh, setup-vm.sh
docker/                      # Dockerfile, docker-compose.yml, Caddyfile
```

## 5. Components

### 5.1 Webhook ingress (`/api/webhook`)

1. Read the raw body; verify `Interakt-Signature: sha256=<hex>` (HMAC-SHA256 over raw bytes, constant-time compare). Reject with 403 on mismatch. `INTERAKT_WEBHOOK_VERIFY_MODE=off` remains for local sandbox only.
2. Parse. Accept `type` matching `message_received` (case-insensitive, space or underscore). Return 200 `{status:"ignored"}` for everything else including the `Webhook Test` ping.
3. Normalize `data.message` by `message_content_type`:
   - `Text` → `content = message`.
   - `Image` / `Video` / `Document` / `Sticker` → `media_url` stored; `content = message` (caption) or empty.
   - `Audio` → `media_url` stored; `kind = audio`; `content` empty.
   - `Location` → `message` is a JSON string; parse `latitude`, `longitude`, optional `name`, `address`.
   - `InteractiveButtonReply` / `InteractiveListReply` → `message` is a JSON string; take `button_reply.id|title` or `list_reply.id|title`; `content = title`, `interactive_id = id`.
   - Anything unknown → `kind = text`, `content = message` if string, else empty. Log the raw shape to `events` (kind `unknown_payload`) once per content type so real shapes get captured.
4. Idempotency: `messages.provider_message_id` is unique; on conflict return 200 `{status:"duplicate"}`.
5. Upsert the conversation by phone (E.164). Refuse phones that collide with `is_test` rows.
6. Insert the message, update `conversations.last_inbound_at`, enqueue `turn` (see 5.2), return 200 `{status:"queued"}`. Total work is a few milliseconds; no LLM call, no outbound send, no `after()`.

Raw bodies are logged only when `LOG_RAW_WEBHOOKS=1`, never in production.

### 5.2 Queue and worker

pg-boss 12 in the same Postgres (schema `pgboss`). One queue, `turn`, payload `{conversationId}`.

Enqueue options: `singletonKey = conversationId`, `singletonSeconds = 3`, `startAfter = 2` (debounce so a burst becomes one turn), `retryLimit = 2`, `retryBackoff = true`, `expireInSeconds = 120`.

The `turn` queue is created with pg-boss's `singleton` policy, so at most one job per `singletonKey` is active at a time. As a second guard the handler takes `pg_try_advisory_xact_lock(hash(conversationId))` and, if it is already held, requeues itself with a 2 s delay.

Worker: `WORKER_CONCURRENCY` (default 4) turns in flight across conversations, never two for the same conversation. It writes a heartbeat row every 30 s. Migrations are applied by the deploy script (§8), never at process start.

Retry policy: `TRANSIENT` errors (network, 5xx from Interakt or Claude, timeouts) retry through pg-boss. `LIMITED` and `AUTH` errors do not retry; they trigger the fallback path (5.8) and pause Claude.

### 5.3 Turn pipeline

```
gather ─► human mode? ─► first contact? ─► menu keyword? ─► Claude turn ─► render+scrub ─► send ─► persist ─► more pending? requeue
```

1. **Gather:** select the conversation and all `messages` with `role = user` and `answered_turn_id IS NULL`, oldest first. Empty → done.
2. **Human mode:** if `mode = human`, leave messages unanswered and stop. When the admin returns the conversation to agent mode, all pending messages are marked answered by the take-over (the human saw them).
3. **First contact:** `UPDATE conversations SET welcomed_at = now() WHERE id = $1 AND welcomed_at IS NULL RETURNING id`. If a row comes back, send the welcome (5.11) in the language detected by script from the first message. Then, if the gathered messages are only greetings (regex over `hi|hello|hey|namaste|namaskar|नमस्ते|नमस्कार|નમસ્તે`, menu words, menu taps, stickers, or empty content), mark them answered and stop; otherwise continue to the Claude turn in the same job with `welcome_just_sent = true` in the per-turn context so the reply answers the actual question without greeting again. The atomic claim plus the singleton queue makes double welcomes impossible.
4. **Menu keyword:** if every gathered message is a menu word (`menu`, `options`, `help`, `मेन्यू`, `मेनू`, `પર્યાય`, `મેનુ`, `menyu`), send the menu and stop.
5. **Claude turn** (5.4). Inputs: system prompt, per-turn context, transcript. Output: structured reply.
6. **Render and scrub** (5.7).
7. **Send** through Interakt (5.9). `is_test` conversations skip the send and record `delivery_status = test_skipped`.
8. **Persist:** assistant `messages` row with `content` (as sent) and `content_template` (with tokens), `turns` row with status, structured output, tool calls, usage, latency, session id, scrub flag. Mark gathered messages `answered_turn_id`. Update `conversations.language` from the output, `flagged` if `needs_human`.
9. **Requeue** if new unanswered messages arrived during the turn.

Media messages are rendered into the transcript as text before the Claude call: `[voice note received — not transcribed]`, `[photo received]`, `[video received]`, `[document received]`, `[sticker]`, `[location pin: <resolved place>]`, `[menu choice: ambulance]`.

### 5.4 Claude backend

Interface:

```ts
interface LLMBackend {
  runTurn(input: TurnInput): Promise<TurnOutput>;  // TurnOutput = { structured, toolCalls, usage, latencyMs, sessionId } | { error: "LIMITED" | "AUTH" | "TRANSIENT" | "INVALID_OUTPUT", message }
}
```

One implementation this round: `ClaudeCodeBackend` on `@anthropic-ai/claude-agent-sdk` pinned to `0.3.282`, the version verified in the spike (peer dependency `zod@^4`).

`query()` options:

| Option | Value |
|---|---|
| `model` | `CLAUDE_MODEL` (default `claude-sonnet-5`) |
| `effort` | `CLAUDE_EFFORT` (default `medium`) |
| `systemPrompt` | full replacement string (5.5) |
| `mcpServers` | `{ arham: createSdkMcpServer({ tools: [find_ambulances, find_clinics, get_info] }) }` |
| `allowedTools` | exactly the three `mcp__arham__*` names |
| `disallowedTools` | `mcp__claude_ai_*` and every built-in name (defence in depth) |
| `tools` | `[]` (disables all built-in tools; verified) |
| `permissionMode` | `bypassPermissions` with `allowDangerouslySkipPermissions: true` |
| `maxTurns` | `CLAUDE_MAX_TURNS` (default 6) |
| `settingSources` | `[]` |
| `persistSession` | `false` |
| `outputFormat` | `{ type: "json_schema", schema }` (5.6) |
| `cwd` | `/opt/arham/claude-home` (empty directory; no CLAUDE.md, no project settings) |
| `env` | `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CONFIG_DIR=/opt/arham/claude-config`, `HOME=/opt/arham/claude-home`; `ANTHROPIC_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` explicitly removed |
| `abortController` | fires at `CLAUDE_TURN_TIMEOUT_MS` (default 45 000) |

Never `--bare` / bare mode (it ignores the OAuth token).

Result classification:

| Observation | Class | Action |
|---|---|---|
| `subtype = success` with `structured_output` | ok | continue |
| `subtype = error_max_structured_output_retries` | INVALID_OUTPUT | retry the turn once with a shorter transcript; then fallback |
| `rate_limit_event` indicating limit reached, or `is_error` with text matching `/limit|rate limit|too many requests/i` | LIMITED | pause Claude until the reset time parsed from the text, else 15 min; run fallback |
| `is_error` with text matching `/not logged in|invalid.*token|authentication|401/i` | AUTH | pause Claude 15 min, run fallback, raise `events` kind `claude_auth_error` (health turns red) |
| abort/timeout, subprocess crash, other `is_error` | TRANSIENT | pg-boss retry; after the last retry run fallback |

`claude_paused_until` lives in a single-row `worker_state` table so both worker replicas and the health endpoint see it. While paused, turns go straight to the fallback path without spawning the SDK.

Every tool call the SDK reports (assistant `tool_use` blocks and the matching results) is captured into `turns.tool_calls`.

### 5.5 System prompt

Structure, in this order, kept byte-stable per process for prompt caching (the coverage summary is rebuilt at most hourly):

1. **Identity and brand.** WhatsApp helpline assistant for Arham Always Care, the animal-rescue project of Arham Yuva Seva Group. Website `WEBSITE_URL`.
2. **Operating model.** Arham and partner NGOs run free animal ambulances in the listed cities. We give the reporter the right driver's number; the reporter calls; we do not dispatch and must never say "we are sending" or "they are on the way". Partner-operated units are labelled by the system automatically.
3. **Coverage summary.** Generated from the directory: one line per city with its areas, plus the clinic cities. Instruction: use it to normalise typos, transliterate Devanagari/Gujarati place names, and recognise neighbouring suburbs; if the reporter's place is clearly outside every city, say so and suggest a local rescue group.
4. **How to answer an ambulance request.** Call `find_ambulances` with the city and area you understood. One candidate → give it. Two or three → give them all. More → ask which area, naming real areas from the tool result. None → out of coverage reply. Always include a token for each number you give; never write digits.
5. **Other intents.** Clinics via `find_clinics`. Donate, volunteer, about, FAQ, human emergency via `get_info`. Medication or treatment advice: don't; offer the nearest clinic. Human emergencies: give 112/108 from `get_info("human_emergency")`. Requests for a human, complaints, or anything you cannot handle: say so, include `{{PHONE:helpline}}`, and set `needs_human`.
6. **Conversation rules.** Remember everything said earlier in this chat; never re-ask for a location you already have. Short acknowledgements ("ok", "thanks", "🙏") get one short warm line, no menu, no "anything else?" every time. Ask at most one clarifying question per reply.
7. **Style.** Reply in the reporter's language and script; Hinglish stays Hinglish. Two to five short sentences. WhatsApp formatting only (`*bold*`, `_italic_`, line breaks); no markdown headings, bullets or `**`. One emoji at most. Warm, calm, practical.
8. **Token grammar.** `{{AMB:<handle>}}`, `{{CLINIC:<handle>}}`, `{{PHONE:helpline}}`. Tokens are the only way a phone number can appear.
9. **Output contract.** Fill every field of the JSON schema; `reply` is the exact message to send.

Per-turn context appended after the cached prefix: IST date and time, conversation language so far, location known so far, handles already shared, whether the welcome menu was shown, then the transcript (last 30 messages, assistant messages in their template form so tokens, not digits, appear).

### 5.6 Output schema

```json
{
  "type": "object",
  "properties": {
    "reply":    { "type": "string", "minLength": 1, "maxLength": 1500 },
    "language": { "enum": ["en", "hi", "mr", "gu"] },
    "intent":   { "enum": ["ambulance", "clinic", "donate", "volunteer", "faq", "suggestion", "smalltalk", "other"] },
    "location": { "type": "object", "properties": { "city": { "type": ["string", "null"] }, "area": { "type": ["string", "null"] } }, "required": ["city", "area"], "additionalProperties": false },
    "needs_human": { "type": "boolean" },
    "notes": { "type": ["string", "null"] }
  },
  "required": ["reply", "language", "intent", "location", "needs_human", "notes"],
  "additionalProperties": false
}
```

`notes` is a one-line internal reason (shown on the admin page), never sent.

### 5.7 Tools

All tools run in-process in the worker with the shared Postgres pool. None returns a phone number.

**`find_ambulances({ city?: string, area?: string, query: string })`**
Returns `{ candidates: [{ handle, display_name, city, area, areas_covered, category, operator_name, operator_is_arham, match: "area" | "city" | "neighbour" | "fuzzy" }], city_areas?: string[], out_of_coverage: boolean }`. `city_areas` is present when the city matched but has more than three units, listing distinct areas so the model can ask.

**`find_clinics({ city?: string })`**
Returns `{ clinics: [{ handle, label, city, area, address, hours }] }`.

**`get_info({ topic: "donate" | "volunteer" | "about" | "faq" | "human_emergency" | "helpline" })`**
Returns the localized content object from `src/content/static.json` in the conversation language with English fallback; fields that are still `TODO` are omitted. Any phone in the content is replaced by a token before returning (`{{PHONE:helpline}}`, `{{PHONE:volunteer}}`).

**Handles** are stable within a conversation: `amb_` + first 8 hex of `sha256(conversationId + ambulanceId)`, likewise `cli_`. The turn runner keeps a registry `handle → row` per conversation (persisted in `turns.handles` and rebuilt from history), so a token that Claude repeats from an earlier turn still resolves.

### 5.8 Directory matcher

Engine behind `find_ambulances`, ported from V1 and tightened:

1. Normalize: lowercase, strip punctuation, apply city aliases (Bangalore→Bengaluru, Bombay→Mumbai, Gurgaon→Gurugram, ...).
2. If `city` is given, restrict rows to that city (exact after aliasing, else Levenshtein ≤ 2 for names ≥ 7 chars, ≤ 1 for 4–6).
3. Tier 1 area exact (`area` or any `areas_covered`), Tier 2 city exact, Tier 3 substring, Tier 4 token, Tier 5 fuzzy token, Tier 6 neighbour map. First non-empty tier wins; `match` records which.
4. No hit → `out_of_coverage: true`, `candidates: []`.

The coverage summary in the prompt plus Claude's own geography reduce the load on tiers 5–6; the neighbour map stays as a safety net and is extended when evals reveal gaps.

### 5.9 Reply rendering and safety

1. **Substitute tokens.** `{{AMB:h}}` → `+91 XXXXX XXXXX` and, when the unit is partner-operated, ` (operated by <partner>)` in the reply language. `{{CLINIC:h}}` → the clinic phone. `{{PHONE:helpline}}` → `HELPLINE_PHONE` formatted. Unknown handle → token removed and `events` kind `unknown_handle` logged.
2. **Card fallback.** If `intent = ambulance`, the reply contains no `{{AMB` token, and the last `find_ambulances` result had exactly one candidate, append the deterministic card (name, number, partner label, "please call them directly"). Two or three candidates → append the multi-card. Otherwise nothing.
3. **Scrub.** Find every run matching `(?:\+?\d[\s\-]?){7,}`. Allowed runs: those inserted in step 1, numbers previously sent in this conversation, and nothing else. On a violation: one corrective retry of the Claude turn with an appended instruction ("your reply typed a phone number; use tokens"). If the retry still violates, strip the run, log `events` kind `scrub_strip`, set `turns.scrubbed = true`.
4. **Format cleanup.** Convert `**x**` to `*x*`, drop `#` headings and leading `- ` bullets, collapse triple newlines, trim to 4000 chars.
5. **Dispatch-language guard.** If the reply matches `/we('| a)re sending|on (the|their) way|dispatch(ed|ing)|भेज रहे|पाठवत आहोत|મોકલી રહ્યા/i`, treat like a scrub violation: retry once with a correction note, then replace the offending sentence with the localized line "Please call them directly and they will guide you." and log `events` kind `dispatch_language_strip`.

### 5.10 Fallback path (Claude unavailable)

Runs when `claude_paused_until > now()` or after the classifications in 5.4. Pure code, no model:

1. Language = `conversations.language` or script detection of the latest message.
2. Run the directory matcher on the concatenated gathered text (aliases include Devanagari and Gujarati spellings of every covered city, generated once from a transliteration table in `src/server/directory/aliases.ts`).
3. One candidate → card. Two or three → multi-card. None → helpline card: "I couldn't find that area right now. Please call our helpline: <HELPLINE_PHONE>."
4. Persist a `turns` row with `status = fallback`, flag the conversation with reason `claude_unavailable`, send.

The fallback never asks questions and never promises a callback.

### 5.11 Welcome and menu

First contact sends the welcome as an Interakt `InteractiveList` (body = the existing welcome text minus the "reply with" line; button label "Options"; rows `menu:ambulance`, `menu:clinic`, `menu:donate`, `menu:volunteer`, `menu:suggestion` with localized titles). If the list send fails, send the existing plain-text welcome. `menu` keyword re-sends the same list. A tap arrives as `InteractiveListReply`; the parser stores `interactive_id` and renders `[menu choice: ambulance]` for Claude.

### 5.12 Interakt client

`POST https://api.interakt.ai/v1/public/message/` with `Authorization: Basic <key>`. Text, InteractiveList, and Template payloads. Phone splitting by length (10 → +91; 12 starting 91 → +91 + last 10; otherwise last 10 digits). Responses and failures are recorded on the message row (`delivery_status`, `error`). Free-form sends are only valid within 24 h of the reporter's last inbound; the admin reply box refuses with an explanation outside that window (templates are kept in the client for future use but not sent in this round).

### 5.13 Media

- **Location:** reverse geocode with Nominatim (`zoom=16&addressdetails=1`, custom `User-Agent`, `email` param, results cached by lat/lng rounded to 3 decimals, ≤1 request/s via a worker-local limiter). Place = `suburb || neighbourhood || village` + `city || town || state_district`. `GOOGLE_GEOCODING_API_KEY` switches the provider when set. Failure → `[location pin received]` and Claude asks for the area.
- **Audio:** store `media_url`. When every gathered message in a turn is audio, the reply is the localized line "I can't listen to voice notes yet, please type your message", sent without a Claude call (`origin = system`), and the messages are marked answered. When a burst mixes audio and text, the audio is rendered as `[voice note received — not transcribed]` in the transcript and the text goes to Claude as usual.
- **Image / video / document / sticker:** stored, rendered as text for Claude, answered normally.
- Media URLs are Interakt-hosted SAS links; they are stored as-is (no download) since nothing consumes them this round.

### 5.14 Language

`lang.ts` detects script (Devanagari with Marathi markers, Gujarati, Hinglish keywords, else English) for the welcome and the fallback path. After every Claude turn, `conversations.language` is set from the structured output, so cards, fallback text, and the menu follow the reporter when they switch.

### 5.15 Admin page

- `/admin/login` with `ADMIN_PASSWORD`; success sets an HttpOnly cookie carrying an HMAC (secret `SESSION_SECRET`) over an expiry 30 days out. Five failed attempts per IP per 15 minutes are rejected.
- Middleware protects `/admin/*`, `/test-chat/*`, `/api/admin/*`, `/api/test-chat/*`.
- Conversation list (newest activity first) with filters `flagged`, `human`, `test`; search by phone suffix or name.
- Transcript view: messages with kind badges; each assistant message expands to its turn (status, structured output, tool calls with inputs and outputs, usage, latency, scrubbed flag, notes).
- Take-over toggle (`mode`), reply box (sends via Interakt, records `messages` with `origin = human`), clear-flag button.
- Live updates: `/api/admin/stream` is a server-sent events endpoint fed by Postgres `LISTEN admin_updates`; triggers on `messages` insert and `conversations` update call `pg_notify`. The page refetches on events, with a 5 s polling fallback.
- Dark UI in the existing style; no new design system.

### 5.16 Test-chat harness

Kept, moved behind the admin cookie, `ENABLE_TEST_CHAT` gate removed. Creating a test conversation inserts `is_test = true` with phone `+91TEST_<id>`; sending a message goes through the same webhook-equivalent insert and `turn` job; the worker skips Interakt for `is_test`. The turn details expander is the same component as the admin transcript.

## 6. Data model

Drizzle migrations in `src/server/db/migrations`. All timestamps `timestamptz`.

- `operators(id, name unique, is_arham, active, created_at)`
- `ambulances(id, operator_id, label, city, area, state, phone, phone_raw, areas_covered text[], category, active, updated_at, created_at)` with indexes on `city`, `operator_id`, GIN on `areas_covered`.
- `clinics(id, operator_id, label, city, area, state, phone, phone_raw, address, hours, active, created_at)`.
- `conversations(id, phone unique, name, language, mode check in (agent, human), flagged bool, flag_reason, welcomed_at, last_inbound_at, last_outbound_at, is_test bool, created_at, updated_at)` with indexes on `updated_at desc`, `flagged`, `is_test`.
- `messages(id, conversation_id fk cascade, role check in (user, assistant), origin check in (reporter, agent, fallback, human, system), content, content_template, kind, media_url, transcript, lat, lng, place_label, provider_message_id unique, interactive_id, delivery_status, error, answered_turn_id, created_at)` with index `(conversation_id, created_at)` and partial index on `(conversation_id) where role = 'user' and answered_turn_id is null`.
- `turns(id, conversation_id, status check in (ok, fallback, failed), model, effort, structured_output jsonb, tool_calls jsonb, handles jsonb, usage jsonb, latency_ms, session_id, error, scrubbed bool, created_at)` with index `(conversation_id, created_at)`.
- `events(id, conversation_id nullable, kind, payload jsonb, created_at)` with index `(kind, created_at desc)`.
- `worker_state(singleton bool primary key default true, claude_paused_until, last_heartbeat_at, last_ok_turn_at)`.
- `geocode_cache(key text primary key, place_label, raw jsonb, created_at)`.
- pg-boss owns schema `pgboss`.

No data is migrated from V1 (the Supabase project is gone). The CSV ingest populates `operators`, `ambulances`, `clinics`.

## 7. Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL`, `POSTGRES_PASSWORD` | Postgres |
| `INTERAKT_API_KEY`, `INTERAKT_WEBHOOK_SECRET`, `INTERAKT_WEBHOOK_VERIFY_MODE` | Interakt |
| `CLAUDE_CODE_OAUTH_TOKEN` | one-year token from `claude setup-token` on the owner's laptop |
| `CLAUDE_TOKEN_ISSUED_AT` | ISO date the token was generated; health endpoint counts down 365 days from it |
| `CLAUDE_MODEL`, `CLAUDE_EFFORT`, `CLAUDE_MAX_TURNS`, `CLAUDE_TURN_TIMEOUT_MS` | backend tuning |
| `LLM_BACKEND` | `claude-code` (only value this round; reserved for `anthropic-api`) |
| `HELPLINE_PHONE` | human helpline number in E.164, used by `{{PHONE:helpline}}` and the fallback card |
| `WEBSITE_URL` | shown in welcome and content |
| `ADMIN_PASSWORD`, `SESSION_SECRET` | admin auth |
| `PUBLIC_HOSTNAME`, `ACME_EMAIL` | Caddy |
| `NOMINATIM_USER_AGENT`, `NOMINATIM_EMAIL`, `GOOGLE_GEOCODING_API_KEY` | geocoding |
| `AZURE_BACKUP_SAS_URL` | backup target |
| `WORKER_CONCURRENCY`, `LOG_LEVEL`, `LOG_RAW_WEBHOOKS` | ops |
| `ENABLE_TEST_CHAT` | removed; the test-chat harness is gated by the admin cookie instead |

`.env.example` documents every variable. Secrets live in `/opt/arham/.env`, owner root, mode 600.

## 8. Infrastructure and operations

**VM:** Ubuntu 24.04 LTS, B2pls_v2, Central India, 64 GiB Standard SSD OS disk, Standard static public IP with DNS label `arham-helpline` (fallback hostname `arham-helpline.centralindia.cloudapp.azure.com`). `scripts/setup-vm.sh` installs Docker CE, enables unattended-upgrades, configures ufw (22, 80, 443), fail2ban, a 2 GiB swapfile, and creates `/opt/arham`.

**DNS:** Namecheap A record `helpline.arhamalwayscare.org → <VM IP>`, TTL 300. Caddy obtains and renews the Let's Encrypt certificate.

**Compose services:** `caddy` (ports 80/443), `app` (`node server.js`, Next.js standalone), `worker` (`node dist/worker.js`), `postgres:17` (volume `pgdata`), `backup` (supercronic, `30 21 * * *` UTC = 03:00 IST: `pg_dump -Fc | gzip | azcopy` to the `backups` container; Blob lifecycle rule deletes objects older than 30 days). Images are built on the VM (native arm64). Log driver `json-file` with rotation (10 MB × 5). Health checks on `app` (`/api/health`) and `postgres` (`pg_isready`); `restart: unless-stopped` everywhere.

**Deploy:** `scripts/deploy.sh` runs `ssh vm 'cd /opt/arham/app && git pull --ff-only && docker compose up -d --build && docker compose exec app node scripts/migrate.js'` then curls `/api/health`. Rollback = `git checkout <previous tag>` and redeploy.

**Health:** `/api/health` returns 200 with `{db, worker_heartbeat_age_s, last_ok_turn_age_s, claude_paused_until, token_days_left}` or 503 when the DB is unreachable, the worker heartbeat is older than 120 s, or an `AUTH` event happened in the last hour. Token expiry is stored as `CLAUDE_TOKEN_ISSUED_AT` (date the owner ran `setup-token`) and warned at 30 days. A free UptimeRobot monitor polls every 5 minutes and emails the owner.

**Logs:** pino JSON to stdout, phones masked to the last 4 digits, no message bodies at `info`; `debug` level may include bodies and is off in production.

**Backups and restore:** nightly dump as above; `docs/runbooks/restore.md` documents `azcopy` download and `pg_restore` into a fresh volume, tested once before pilot.

**Token renewal:** yearly; the owner runs `claude setup-token`, updates `/opt/arham/.env`, and `docker compose up -d worker`.

**Recommended (owner's account, no code):** enable "extra usage" with a monthly cap on the Max plan so throttling overflows to pay-per-use instead of the fallback path.

## 9. Testing and evals

**Unit tests (vitest):** directory matcher tiers and aliases (Latin, Devanagari, Gujarati), token substitution and partner labelling, scrubber allow-list and stripping, dispatch-language guard, webhook parser fixtures for every content type in 5.1 including the `Webhook Test` ping and a duplicate id, coalescing and the first-contact claim under concurrent inserts, language detection.

**Eval suite (`npm run eval`):** YAML scenarios under `evals/scenarios/`, each a scripted multi-turn conversation with assertions on the sent text and the turn record. Runs against the real worker in test mode with a fake Interakt sender. Output: pass/fail table, P50/P95 latency, tokens per turn. A scenario is safety-critical when its assertions concern digits, dispatch language, or a wrong unit. Initial scenarios:

1. Injured dog, "Ghatkopar" → single unit, Arham label, number resolved, reply in Hinglish.
2. "Munbai - goregaon" → Malad unit via neighbour/alias, no "we don't run there".
3. "Bangalore" → Bengaluru units.
4. "Mumbai" → asks which area, names real areas, no numbers yet; then "Andheri" → number.
5. "Lucknow" → out of coverage, suggests local group, helpline token present.
6. Devanagari "घाटकोपर में कुत्ता घायल है" → Ghatkopar unit, Hindi reply.
7. Gujarati "સુરતમાં ગાય ઘાયલ છે" → Surat unit, Gujarati reply.
8. Marathi "पुण्यात कुत्रा जखमी आहे" → asks area or gives Pune units, Marathi reply.
9. Burst: "hi" / "hello" / "dog injured near station rajkot" within 2 s → one welcome, then one reply with Rajkot units.
10. "ok" / "thanks" / "🙏" after a number → one short line each, no menu, no repeated thank-you.
11. "I want to talk to a human" → helpline token, `needs_human = true`, conversation flagged; bot keeps answering afterwards.
12. "a human hit the dog in Chembur" → ambulance flow, not flagged.
13. "what medicine should I give?" → declines advice, offers clinic, no drug names.
14. "donate" → donation content with URL, no TODO strings.
15. "volunteer" → volunteer content.
16. "clinic in Surat" → clinic card with number.
17. Location pin near Karve Nagar, Pune → Pune unit.
18. Voice note → "please type" reply in the conversation language, no Claude turn.
19. Menu tap `menu:ambulance` → asks for the city.
20. Claude paused (forced) + "Ghatkopar" → fallback card within 5 s, turn status `fallback`, conversation flagged.
21. Scrubber: a fixture backend returning a reply with typed digits → digits never sent, `scrubbed = true`.
22. Partner unit (e.g. a Blue Cross unit) → "(operated by ...)" present in the reply language.

An optional LLM judge (same backend) scores tone and brevity on a 1–5 rubric for reporting only; it never gates.

**Acceptance before pilot:** all unit tests green, evals per §1 success criteria, restore runbook executed once, health endpoint green for 24 h on the VM, Interakt webhook switched and a real message answered end to end.

## 10. Security and privacy

- Webhook HMAC verification is mandatory in production; the endpoint also rejects bodies over 256 KB.
- Admin and test-chat surfaces are behind the password cookie; the login endpoint is rate-limited.
- No anonymous database access from the browser; the browser only talks to the app's own API.
- Reporter phone numbers appear in the database and the admin page only; logs mask them.
- `.codex/`, `.mcp.json`, `.env*` are gitignored. The Supabase personal access token found in `.codex/config.toml` must be revoked by the owner.
- The Claude token is a secret equivalent to the owner's subscription; it exists only in `/opt/arham/.env`.
- Postgres listens only on the Compose network. SSH is key-only.

## 11. Migration and cleanup

**Delete:** `supabase-*.sql`, `src/lib/supabase.ts`, `.vercel/`, `vercel.json`, `CRON_SETUP.md`, `src/app/api/cron/*`, `src/lib/clients/*`, `src/lib/tools/escalate-to-dispatcher.ts`, `get-case-by-reporter.ts`, `get-nearest-ambulance.ts`, `src/lib/messages/followup.ts`, `closure.ts`, `src/lib/conversation-lock.ts`, `src/lib/ai-provider.ts`, `src/lib/ai.ts`, the old `src/app/api/conversations/*` routes and `src/app/page.tsx` dashboard, `AGENTS.md` (replaced by a two-line pointer to CLAUDE.md), the `@ai-sdk/*`, `ai`, `@supabase/supabase-js` dependencies.

**Keep and move:** ambulance card formatting, city aliases, neighbour map, fuzzy matcher, language detection, welcome/menu texts, static content, Interakt send client and webhook parser (extended), test-chat UI (moved under admin), ingest script (retargeted).

**Add:** everything under `src/server/`, `evals/`, `docker/`, the scripts, drizzle migrations, vitest config.

**Docs:** rewrite `CLAUDE.md` (architecture, hard rules 1, 2, 4, 6, 7, 9, 10 of V1 retained; escalation, instant-ack and closure rules retired), `README.md` (local dev with `docker compose up postgres`, deploy, runbooks), `.env.example`.

## 12. Assumptions to confirm

1. **Website URL** is `https://arhamalwayscare.org` (the domain the owner controls). V1 content used `https://alwayscare.org`; the owner confirms which one goes into the welcome and static content.
2. **`HELPLINE_PHONE`** exists: a staffed number the bot may hand out when it can't help. The owner supplies it before pilot.
3. **Static content gaps** (UPI id, bank details, volunteer contact, Hindi/Marathi/Gujarati translations) are filled by the owner; until then the English text is used and `TODO` fields are omitted.
4. **Interakt plan** already delivers `message_received` webhooks (it did in V1) and supports `InteractiveList` sends; if a list send returns 400, the text welcome is used permanently.
5. **Arm64** works for the Agent SDK's bundled CLI; otherwise the VM is swapped to B2als_v2.
6. **No V1 data** needs to be preserved.

## 13. Implementation phases (for the plan)

1. **Foundation:** repo cleanup, Postgres + Drizzle schema, Docker Compose for local dev, ingest script, unit-test scaffolding.
2. **Ingress and worker without Claude:** webhook, queue, coalescing, first-contact claim, welcome list, fallback path, Interakt client, admin page with login and transcripts. Deployable as a "dumb but safe" bot.
3. **Claude backend:** Agent SDK backend, prompt, tools, structured output, rendering, scrubber, eval runner and the 22 scenarios.
4. **Media and admin polish:** location pins, audio/photo handling, take-over and reply box, SSE, test-chat under admin.
5. **Azure:** VM setup script, DNS, Caddy, backups, health monitor, deploy script, restore drill, Interakt webhook switch, pilot.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Max plan throttling or policy enforcement stops Claude | Fallback path keeps number delivery working; backend interface allows an API key by env var; extra-usage overflow recommended |
| Agent SDK option names drift between versions | Version pinned; spike script kept under `evals/spike/` as a smoke test run in CI |
| Interakt media/interactive payload shapes differ from community examples | Parser logs unknown shapes once; fixtures updated from real events during pilot |
| 9–14 s turn latency feels slow | Measured per turn; effort and max turns tunable; typing indicator is not exposed by Interakt |
| Single VM is a single point of failure | Nightly backups, documented restore, health alerts; acceptable at this volume |
| Token expires unnoticed | Health endpoint counts down and alerts at 30 days |
