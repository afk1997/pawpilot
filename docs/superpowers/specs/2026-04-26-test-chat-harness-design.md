# Test-Chat Harness — Design Spec

**Date:** 2026-04-26
**Status:** Approved (awaiting user re-review)
**Scope:** Internal testing tool. Single-user (the project owner). Not customer-facing.

## Context

Today the only way to exercise the WhatsApp dispatcher copilot end-to-end is to send a real Interakt message from a real WhatsApp account. That's slow for iteration, polluting for the audit log, and expensive for finding edge cases like the Bangalore→Bengaluru lookup miss. We need a chat harness that talks to the same backend the webhook does, captures the bot's outbound instead of sending it, and supports multiple persistent test conversations.

Goal: turn "I want to try a scenario" from a 30-second WhatsApp round-trip into a 1-second textbox round-trip, while exercising the full pipeline (`processIncomingLocked` + every tool + every orchestrator override).

## Goals

- Type a message in a browser, see the bot respond as if it were Interakt.
- Real `processIncomingLocked()` runs — every tool call, the orchestrator's 1/2-3/4+ row branching, escalation triggers, audit trail, conversation lock.
- Persistent multi-chat: start a new test chat, switch between past test chats, full message history preserved per chat.
- Strict isolation from the dispatcher dashboard: test conversations never appear in dispatcher UI; dispatcher cannot accidentally send to a test conversation; cron jobs never act on test conversations.

## Non-goals (YAGNI)

- No image / voice-note inputs (text only).
- No multi-user / per-tester chat lists or auth (env-var gate is sufficient).
- No fake mock data for Cases API or GPS API — those aren't live yet, the test harness lets them fail/return-empty exactly as production does today.
- No streaming responses, no message editing/deleting.
- No simulated Interakt webhook payloads — direct chat, not protocol replay.
- No transcript export (the Supabase `messages` table is queryable directly).

## Architecture

```
Test UI                                      Real webhook
   │                                              │
   ▼                                              ▼
POST /api/test-chat/...                  POST /api/webhook (Interakt)
   │                                              │
   └──────────────────┬───────────────────────────┘
                      ▼
              processIncomingLocked()       ← unchanged shared entry point
                      ▼
                 sendAndPersist()
                  │       │
       conv.is_test       │ !is_test
                  ▼       ▼
            skip send    sendWhatsAppMessage(Interakt)
                  │       │
                  └───────┴──────► insert into messages table
                                       │
                                       ▼
                                Supabase Realtime
                                       │
                                       ▼
                                 Test UI / Dashboard
                                 (each filters by is_test)
```

The load-bearing trick: the only behavioural difference between real and test is whether `sendWhatsAppMessage()` actually fires. Everything else — DB writes, tool calls, audit, the lock — runs identically. The bot's reply still gets persisted to `messages`; the test UI subscribes to that conversation via Supabase Realtime (same mechanism the dashboard already uses) and renders it as it lands.

## Data model

One column added to `conversations`:

```sql
alter table conversations add column is_test boolean default false not null;
create index conversations_is_test_idx on conversations(is_test);
```

Migration file: `supabase-migration-test-chat.sql` (incremental, applies on top of existing schema).

`messages`, `agent_actions`, and other tables are unchanged. Test-vs-real is inferable from the joined `conversations.is_test` for those.

Test conversations use a fake reporter phone of the form `+91TEST_<short-uuid>` so the existing unique-phone constraint on `conversations.reporter_phone` is satisfied without collision risk against real Interakt traffic. The `+91TEST_` prefix is intentionally non-E.164 so any code path that would try to dial it via Interakt fails fast.

## Test-isolation policy

This is the part where half-baking causes leaks. Every conversation-touching code path needs an explicit position on `is_test`. No defaults, no implicit behavior.

### Filter `is_test = false` (dispatcher / production paths)

| File | Today's query | Change |
|---|---|---|
| `src/app/api/conversations/route.ts` | list all conversations | add `.eq('is_test', false)` |
| `src/app/api/conversations/[id]/route.ts` | fetch single by id | add `.eq('is_test', false)` — 404 if test |
| `src/app/api/conversations/[id]/messages/route.ts` | list messages for conv | precheck conv.is_test → 404 if test |
| `src/app/api/conversations/[id]/send/route.ts` | dispatcher manual send | precheck conv.is_test → 404 if test (dispatcher must NEVER manually send to a test convo) |
| `src/app/api/cron/followup/route.ts` | iterate convs needing followup | scope to `is_test = false` |
| `src/app/api/cron/closure/route.ts` | iterate for closure summary | scope to `is_test = false` |
| `src/app/api/cron/idle/route.ts` | iterate idle convs | scope to `is_test = false` |
| `src/app/api/webhook/route.ts` | find/create conv by phone | add `is_test = false` filter on lookup (defense in depth — `+91TEST_*` phones can't realistically come from Interakt, but explicit > implicit) |
| `src/app/page.tsx` | Realtime subscription on `conversations` and `messages` | client-side guard: drop incoming rows where `new.is_test === true` |

### Filter `is_test = true` (test paths)

| File (new) | Filter |
|---|---|
| `src/app/api/test-chat/conversations/route.ts` | list: `is_test = true`; create: insert with `is_test: true` |
| `src/app/api/test-chat/conversations/[id]/messages/route.ts` | list/post: precheck conv.is_test → 404 if false |
| `src/app/test-chat/page.tsx` | Realtime subscription: drop rows where `new.is_test === false` |

### `processIncomingLocked` ↔ `sendAndPersist`

`processIncomingLocked()` already loads the conversation row at start. Read `is_test` from that row, store in the local processing context, and pass through to `sendAndPersist`. The send short-circuit is one branch:

```ts
async function sendAndPersist(input, text, metadata) {
  const send = input.is_test
    ? { ok: true, status: 200, error: null, skipped: true }
    : await sendWhatsAppMessage(input.reporterPhone, text);
  // existing message-row insert proceeds either way.
  // delivery_status: send.skipped ? "test_skipped" : (send.ok ? "sent" : "failed")
  ...
}
```

The new `delivery_status` enum value `"test_skipped"` makes test-mode messages distinguishable in the audit log without polluting the existing `sent`/`failed` semantics. No DB constraint change needed if `delivery_status` is `text`; if it's an enum, the migration adds the new value.

This single gate covers:
- LLM responses to the reporter
- Orchestrator-built ambulance cards (single + multi)
- Escalation messages to the dispatcher (since `escalate_to_dispatcher` calls `sendWhatsAppMessage` for the dispatcher ping — same gate intercepts it)
- Static-content delivery (donate / volunteer / clinic cards)
- Followup / closure messages (cron paths, but those are also scoped out at the cron query level — defense in depth)

`is_test` is bound to the conversation row, never inferred from request shape. There's no way to "forget" to mark a request as test mid-flow.

## API surface

### `POST /api/test-chat/conversations`

Create a new test conversation.

```ts
// request
{ language?: "en" | "hi" | "mr" | "gu" }

// response
{ conversationId: string, reporterPhone: string }
```

Inserts a row with `is_test: true`, generated `+91TEST_<uuid>` phone, `language`, `mode: "agent"`, `status: "active"`. Returns the id and synthetic phone for client display.

### `GET /api/test-chat/conversations`

List test conversations, most recent first.

```ts
// response
{
  conversations: Array<{
    id: string,
    reporter_phone: string,    // +91TEST_*
    language: string,
    created_at: string,
    last_message_at: string,
    last_message_preview: string,  // first 100 chars
    message_count: number,
  }>
}
```

### `GET /api/test-chat/conversations/[id]/messages`

Full message history for a test conversation.

```ts
// response
{
  messages: Array<{
    id: string,
    role: "user" | "assistant" | "system",
    content: string,
    message_type: string,
    created_at: string,
    tool_calls?: Array<{ name, args, output, failed, duration_ms }>,  // for debug toggle
  }>
}
```

Tool-calls included on assistant messages so the UI can show a per-message debug expander.

### `POST /api/test-chat/conversations/[id]/messages`

Send a user message in a test conversation. Triggers `processIncomingLocked()`. Returns immediately — the bot's reply lands via Realtime.

```ts
// request
{ content: string }

// response
{ messageId: string, queued: true }
```

### Env-var gate

All `/api/test-chat/*` and the `/test-chat` page check `process.env.ENABLE_TEST_CHAT === "1"` at the top. If absent, return 404 (the page does `notFound()`, the API routes return `Response.json({...}, { status: 404 })`). Off by default in production. Set to `"1"` locally and on staging/preview when using the harness.

## UI

Single page at `/test-chat`. Two-pane layout:

```
┌──────────────────┬──────────────────────────────────┐
│ + New chat       │  [chat title / phone tag]   [↻] │
│ ─────────────────│ ────────────────────────────────│
│ ▸ Bangalore test │                                  │
│   Mumbai BKK     │  ▸ User: Bangalore               │
│   Volunteer flow │  ▸ Bot:  [multi-card]            │
│   …              │   └─ debug ▾ tool calls          │
│                  │  ▸ User: which one is closer?   │
│                  │  ▸ Bot:  …                       │
│                  │                                  │
│                  │  ┌──────────────────────────┐   │
│                  │  │ type a message…   [send] │   │
│                  │  └──────────────────────────┘   │
└──────────────────┴──────────────────────────────────┘
```

- **Sidebar:** lists test conversations (most recent first). Each row shows the synthetic phone, first user-message preview, last-active timestamp. "+ New chat" creates one and switches to it; "New chat" opens a small inline form to pick language (defaults to English).
- **Active chat:** message bubbles (user right, assistant left). Per-assistant-message debug toggle (small caret) expands to show tool calls made, args, results, durations. This is the critical bit for "why did the bot answer X?" debugging.
- **Composer:** plain textarea + send button. Enter sends, Shift+Enter newline. Disabled while a turn is in flight.
- Realtime subscription on the active conversation's messages → new assistant messages stream in as bubbles.

No streaming token-by-token. No fancy animations. Internal tool — message-arrives-as-bubble is enough.

## First-contact welcome+menu

The webhook today sends a deterministic welcome+menu message synchronously on first contact (no prior assistant messages). For test mode parity, the same logic must run when a test conversation's first user message arrives. To avoid duplication:

- Extract the welcome decision + send logic from `src/app/api/webhook/route.ts` into a new helper `src/lib/messages/handle-first-contact.ts` exporting `handleFirstContactIfNeeded(input)`.
- Webhook route calls this helper.
- Test API route calls the same helper, with `input.is_test = true` so the `sendAndPersist` gate skips the actual Interakt call but still persists the welcome message to the messages table → test UI sees it via Realtime.

## Stub matrix

| Component | Test-mode behavior |
|---|---|
| `find_ambulance_by_area` | Real — hits `ambulances` table |
| `get_static_content` | Real — donate/volunteer/clinics |
| `escalate_to_dispatcher` | Real audit row written; dispatcher WhatsApp ping skipped via the `is_test` gate at `sendWhatsAppMessage` call site |
| `get_case_by_reporter` | Real call → currently fails because Cases API isn't live → tool returns whatever it returns today (likely empty/error). No fake mocks. |
| `get_nearest_ambulance` | Real call → degraded path because GPS API isn't live. No fake mocks. |
| `sendWhatsAppMessage` | Skipped at call site when `conv.is_test` true. Returns `{ ok: true, skipped: true }`. |
| First-contact welcome+menu | Real logic, persisted to messages, send skipped (so test UI still sees it via Realtime) |
| Cron followup / closure / idle | Test conversations excluded at cron query level — these jobs never wake test conversations |
| Audit (`agent_actions`) | Written normally for test conversations. Audit queries can join to `conversations.is_test` if filtering ever becomes needed. |

## Files touched

**New:**
- `src/app/test-chat/page.tsx` — main UI
- `src/app/api/test-chat/conversations/route.ts` — list / create
- `src/app/api/test-chat/conversations/[id]/messages/route.ts` — list messages / send message
- `src/lib/messages/handle-first-contact.ts` — extracted welcome+menu helper
- `supabase-migration-test-chat.sql` — `is_test` column + index

**Modified (existing files, scoped changes only):**
- `src/lib/processor/process-incoming.ts` — read `is_test` from conversation row; pass to `sendAndPersist`; one-line short-circuit in send call
- `src/lib/whatsapp.ts` — no change (gate lives in caller, not here, since this file shouldn't know about app-level concepts)
- `src/app/api/webhook/route.ts` — call `handleFirstContactIfNeeded()`; add `is_test = false` to conversation lookup; remove the inline first-contact code that's now in the helper
- `src/app/api/conversations/route.ts` — add `.eq('is_test', false)`
- `src/app/api/conversations/[id]/route.ts` — add `.eq('is_test', false)` (or precheck + 404)
- `src/app/api/conversations/[id]/messages/route.ts` — precheck conv.is_test → 404 if true
- `src/app/api/conversations/[id]/send/route.ts` — precheck conv.is_test → 404 if true
- `src/app/api/cron/followup/route.ts` — scope query to `is_test = false`
- `src/app/api/cron/closure/route.ts` — scope query to `is_test = false`
- `src/app/api/cron/idle/route.ts` — scope query to `is_test = false`
- `src/app/page.tsx` — client-side filter on Realtime: drop rows where `new.is_test === true`

**Env:**
- `.env.example` — add `ENABLE_TEST_CHAT=` (commented placeholder)
- `.env.local` — set `ENABLE_TEST_CHAT=1` locally (manual, not committed)

## Verification checklist

Implementation is not done until each of these passes:

1. **Migration applied** — `is_test` column exists on `conversations` with `default false not null`.
2. **Existing real conversations still appear** in the dispatcher dashboard at `/`.
3. **Creating a test conversation** via test UI → it does NOT appear in dispatcher dashboard sidebar.
4. **Existing real conversation `is_test=false` rows** still selectable in dispatcher dashboard, messages still load.
5. **Dispatcher manual-send to a test conversation id** (forced via direct API call) → 404, never sends.
6. **Test UI does NOT see real conversations.**
7. **Sending a test message** → `processIncomingLocked` runs → `find_ambulance_by_area` tool fires → orchestrator delivers card → assistant message appears in test UI within 5s. Verified via DB query: corresponding `messages` row exists with `delivery_status` indicating skipped/test, and **no Interakt API call** was made (verifiable by absence of debug log line, or by checking `INTERAKT_DEBUG_LOG`).
8. **Multi-card path** — a query like "Bangalore" returns 2 rows → multi-card delivered → no area-asking.
9. **Escalation path** — sending a "can't reach driver" trigger in test mode → audit row created for escalation, but no real WhatsApp ping sent to dispatcher.
10. **Cron jobs** (run manually with the `CRON_SECRET`) — verify followup/closure/idle queries return zero test conversations.
11. **First-contact welcome+menu** lands as the assistant's first message in a fresh test conversation, in the chosen language.
12. **Env-var gate** — with `ENABLE_TEST_CHAT` unset, `/test-chat` returns 404 and `/api/test-chat/*` endpoints return 404.
13. **Typecheck** clean (`npx tsc --noEmit`).

## Out of scope (deferred)

- Delete-test-conversation button (manual DB cleanup if list grows long).
- Renaming test conversations from synthetic phone to a custom label.
- Sharing test conversations with a teammate (requires auth).
- Importing real Interakt payload shapes for protocol-level replay testing.
- Test-data fixtures (canned conversation seeds).
- Side-by-side A/B prompt testing UI.

If any of these become useful after the harness is live, they're additive — not blockers.
