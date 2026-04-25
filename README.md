# Arham Always Care — WhatsApp Dispatch Agent

WhatsApp dispatcher copilot for **Arham Always Care**, the animal-rescue project of Arham Yuva Seva Group. It augments the central 24/7 ops dispatcher who connects reporters of injured stray animals to the right ambulance team.

> **Life-and-death software.** Designed conservatively: the LLM never types phone numbers; phone numbers come from real DB rows. Every action is audited.

## What it does

A reporter messages the Arham Always Care WhatsApp number to report an injured stray animal. Within seconds the agent acks. It then:

1. Asks for the location (city + area, or a WhatsApp location pin).
2. Calls a structured tool to look up the right ambulance from the directory of 45+ ambulances (most operated by Arham, ~11 by partner NGOs).
3. Sends the reporter the driver's phone number, plus a clear note of who operates the ambulance. The reporter calls the driver directly. **The agent does not dispatch.**
4. Gathers context (photo/video/situation) for the case record.
5. 5 minutes later, follows up: "Did you reach the driver?". If "no", it acknowledges, registers the feedback, and escalates to the human dispatcher.
6. When Arham logs a case for the reporter into the Cases API, an opportunistic closure summary is sent.

Languages: English, Hindi (Devanagari + Hinglish), Marathi, Gujarati.

## Architecture

```
Reporter on WhatsApp
  → POST /api/webhook (Interakt)               ← signature verified, deduped
  → instant ack within ~1 second               ← Phase 1 (live)
  → background LLM tool loop                   ← Phase 2 (planned)
       • find_ambulance_by_area
       • get_nearest_ambulance (GPS API)
       • get_case_by_reporter (Cases API)
       • escalate_to_dispatcher
       • get_static_content (donate/volunteer/faq)
  → Interakt API → reporter
  → Supabase + Realtime → dispatcher dashboard
```

Data layer:
- `ngo_operators` — Arham + partner NGOs.
- `ambulances` — directory (45+ rows, ingested from `ambulances-clinics.csv`).
- `clinics` — Arham clinics.
- `conversations` — extends prototype with status, intent, language, dispatch claim.
- `messages` — adds multimedia + delivery status.
- `agent_actions` — full audit log.

Scheduled jobs (Phase 4):
- Vercel Cron every 1 min → 5-minute follow-up.
- Vercel Cron every 5 min → opportunistic closure summary.

## Stack

- Next.js 16 App Router (TypeScript)
- Supabase (Postgres + Realtime)
- Interakt (WhatsApp Business)
- Vercel AI SDK + OpenRouter (default `anthropic/claude-sonnet-4-6`)
- Tailwind CSS
- Vercel (Functions, Cron, Queues)

## Getting started

### 1. Install

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

Fill in: Interakt API key + webhook secret, OpenRouter key, Supabase keys, Cases API + GPS API credentials. The `.env.example` file documents each variable.

### 3. Provision the database

Either run the full schema from a fresh Supabase project:

```bash
psql "$SUPABASE_DB_URL" -f supabase-schema.sql
```

Or apply the incremental migration on top of the prototype:

```bash
psql "$SUPABASE_DB_URL" -f supabase-migration.sql
```

### 4. Ingest the directory

Place the partner / ambulance / clinic spreadsheet at the project root as `ambulances-clinics.csv` (gitignored — contains driver personal numbers), then:

```bash
npm run ingest:ambulances
```

The script is idempotent: re-run any time the spreadsheet changes.

### 5. Configure Interakt webhook

In the Interakt dashboard:

1. Set webhook URL to `https://<your-domain>/api/webhook`.
2. Set the verification token; copy it into `INTERAKT_WEBHOOK_SECRET`.
3. Subscribe to inbound message events.

For local dev, expose `localhost:3000` via ngrok and use the ngrok URL.

### 6. Run

```bash
npm run dev
```

Dashboard at `http://localhost:3000`.

## API routes

| Method | Route | Description |
|---|---|---|
| GET  | `/api/webhook` | Health probe (returns "ok") |
| POST | `/api/webhook` | Inbound from Interakt — verifies, dedups, instant-acks, audits, optionally escalates |
| GET  | `/api/conversations` | List all conversations (dashboard) |
| GET  | `/api/conversations/:id/messages` | Conversation messages |
| PATCH| `/api/conversations/:id` | Update mode/status/claim (dispatcher take-over) |
| POST | `/api/conversations/:id/send` | Manual send from dispatcher dashboard |

## Hard rules (carry into every change)

1. **LLM never types phone digits.** Phone numbers come from DB / API responses.
2. **No dispatching language.** "We're sending" / "they're on the way" — these phrases are forbidden. We hand over a phone number; the reporter calls.
3. **Narrow auto-escalation only.** "Can't reach" + manual "human" + model failure. Severe wording does NOT auto-escalate.
4. **Time-to-driver-number is the metric.** Photo/video/situation gathering happens after delivery, never blocking.
5. **Audit everything.** Every inbound, every tool call (args + result), every outbound, every dispatcher action.

Full design plan: `/Users/kaivan108icloud.com/.claude/plans/now-we-need-to-sprightly-hedgehog.md`.

## Implementation status

- [x] Phase 1 — Foundation (provider swap, DB, ingest, env, audit, instant-ack)
- [ ] Phase 2 — Tool-using agent (Vercel AI SDK, 5 tools, multilingual prompt, queue)
- [ ] Phase 3 — Dashboard (status badges, take-over, audit log panel)
- [ ] Phase 4 — Followup + closure (Vercel Cron)
- [ ] Phase 5 — Multilingual polish + load test
- [ ] Phase 6 — Pilot
