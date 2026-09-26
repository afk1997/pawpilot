// Runs before every test file. Provides a complete, fake environment so
// getConfig() never throws in tests. DB-backed tests override DATABASE_URL.
Object.assign(process.env, { NODE_ENV: "test" });
process.env.LLM_BACKEND = "fake";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://arham:arham@localhost:5439/arham_test";
process.env.INTERAKT_API_KEY = "test-interakt-key";
process.env.INTERAKT_WEBHOOK_SECRET ??= "test-webhook-secret";
process.env.INTERAKT_WEBHOOK_VERIFY_MODE ??= "hmac";
process.env.HELPLINE_PHONE ??= "+919999900000";
process.env.WEBSITE_URL ??= "https://arhamalwayscare.org";
process.env.ADMIN_PASSWORD ??= "test-admin";
process.env.SESSION_SECRET ??= "test-session-secret-at-least-32-chars-long";
process.env.LOG_LEVEL ??= "silent";
delete process.env.ANTHROPIC_API_KEY;
// A run that opts into the Claude smoke test (RUN_CLAUDE_SMOKE=1) keeps the OAuth token the smoke test needs; every
// other run drops it, so no test can reach Claude and spend Max usage by accident.
if (process.env.RUN_CLAUDE_SMOKE !== "1") delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
