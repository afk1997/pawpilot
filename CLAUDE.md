# Arham Always Care — WhatsApp Dispatch Agent

This is the WhatsApp dispatcher copilot for Arham Always Care (the animal-rescue project of Arham Yuva Seva Group, a parent NGO). It augments a 24/7 human dispatcher who connects reporters of injured stray animals to the right ambulance team via WhatsApp. **Life-and-death software** — be conservative.

## Operating model

- **Arham Yuva Seva Group** operates ~34 of the ~45 ambulances directly. ~11 are operated by partner NGOs (Blue Cross, ALAI Trust, Hope for Indies Trust, etc.). The agent must label which is which when sharing a number.
- The agent **does not dispatch** ambulances. It gives the reporter the right driver's phone number; the reporter calls the driver. Avoid all dispatching language ("we're sending", "they're on the way", etc.) — it is misleading.
- Coverage: 23+ cities across Gujarat, Maharashtra, Tamil Nadu, West Bengal, Karnataka, Delhi, Haryana, Telangana, Madhya Pradesh.

## Hard rules

1. **LLM never types phone digits.** Phone numbers come from DB rows / API responses; code formats them into the message. Tools return structured data; LLM types prose around it.
2. **Narrow auto-escalation.** Only on: reporter says "can't reach driver", manual "human" request, or model failure. Severe wording does NOT auto-escalate (would flood dispatcher at 200–1000/day).
3. **Time-to-driver-number is THE metric.** Photo/video/situation gathering happens AFTER delivery. Never block.
4. **Instant ack within ~1s.** Sent before any LLM call.
5. **Audit trail mandatory.** Every inbound, every tool call (args + result), every outbound, every dispatcher action → `agent_actions` table.
6. **Multilingual.** English, Hindi (Devanagari + Hinglish), Marathi, Gujarati. Hardcoded regex must work in all four.
7. **Idempotent.** Dedup webhooks by Interakt message id.
8. **Graceful degradation.** Subsystem failures must be visible, never silent.

## Stack

- Next.js 16 App Router, TypeScript, Tailwind
- Supabase (Postgres + Realtime)
- Interakt (WhatsApp Business; replaces the Meta Graph API the prototype used)
- OpenRouter via Vercel AI SDK (default `anthropic/claude-sonnet-4-6`)
- Vercel (Functions + Cron + Queue)

## Plan

The approved V1 implementation plan: `/Users/kaivan108icloud.com/.claude/plans/now-we-need-to-sprightly-hedgehog.md` — read it before implementation decisions.

## Files of note

- `ambulances-clinics.csv` — source of truth for the directory. **Gitignored** (contains driver personal numbers). Imported via `scripts/ingest-ambulances.ts`.
- `supabase-schema.sql` — DB migration.
- `src/lib/tools/` — LLM tool implementations.
- `src/content/static.json` — donations / volunteer / clinic / FAQ content (multilingual).

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure.
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep.
- After modifying code files, run `graphify update .` to keep the graph current (AST-only, no API cost).
