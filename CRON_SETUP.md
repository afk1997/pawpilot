# Cron jobs

Vercel's Hobby plan only allows daily cron schedules. The agent's three
cron handlers need sub-daily schedules to work properly. Two options:

## Option A — Upgrade to Vercel Pro ($20/mo)

Add this block to `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "crons": [
    { "path": "/api/cron/followup", "schedule": "* * * * *" },
    { "path": "/api/cron/closure",  "schedule": "*/5 * * * *" },
    { "path": "/api/cron/idle",     "schedule": "*/30 * * * *" }
  ]
}
```

Re-deploy. Done.

## Option B — Use a free external cron service

Free services like [cron-job.org](https://cron-job.org) can hit your
Vercel endpoints on any schedule.

For each of these three URLs, add a new job:

| Schedule  | URL                                     | Purpose                          |
|-----------|------------------------------------------|----------------------------------|
| `* * * * *`    | `https://<your-domain>/api/cron/followup` | "Did you reach the driver?" 5 min after delivery |
| `*/5 * * * *`  | `https://<your-domain>/api/cron/closure`  | Opportunistic case-closure summaries (Cases API) |
| `*/30 * * * *` | `https://<your-domain>/api/cron/idle`     | Nudge stuck conversations, auto-close stale ones |

For each job, set this **request header**:

```
Authorization: Bearer <CRON_SECRET>
```

Use the same `CRON_SECRET` value that's set in Vercel env vars. Without
it the cron handlers return 403.

The endpoints are GET requests. Each returns JSON like
`{"status":"ok","processed":N}`.

## Until you set up cron

The agent works end-to-end except the time-based feedback loop:
- Reporters get the instant ack and the driver phone number.
- They will NOT get the 5-min "did you reach?" auto-followup.
- Closure summaries from the Cases API will NOT auto-fire.
- Idle conversations will accumulate until manually closed.

These are quality-of-life features, not safety-critical for the core
dispatch flow. Set them up before pilot, but the agent is testable
without them.
