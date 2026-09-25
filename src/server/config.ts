import { z } from "zod";

const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, "must be E.164 like +919876543210");

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  INTERAKT_API_KEY: z.string().min(1),
  INTERAKT_WEBHOOK_SECRET: z.string().default(""),
  INTERAKT_WEBHOOK_VERIFY_MODE: z.enum(["hmac", "off"]).default("hmac"),
  INTERAKT_API_BASE: z.string().url().default("https://api.interakt.ai/v1/public/message/"),
  LLM_BACKEND: z.enum(["claude-code", "fake"]).default("claude-code"),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
  LLM_TOKEN_ISSUED_AT: z.string().optional(),
  LLM_MODEL: z.string().default("claude-sonnet-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_TURNS: z.coerce.number().int().min(1).max(20).default(6),
  LLM_TURN_TIMEOUT_MS: z.coerce.number().int().min(5_000).default(45_000),
  LLM_HOME_DIR: z.string().default("/tmp/arham-claude-home"),
  HELPLINE_PHONE: e164.describe("HELPLINE_PHONE"),
  WEBSITE_URL: z.string().url().default("https://arhamalwayscare.org"),
  ADMIN_PASSWORD: z.string().min(6),
  SESSION_SECRET: z.string().min(32),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(4),
  LOG_LEVEL: z.string().default("info"),
  LOG_RAW_WEBHOOKS: z.string().default("0"),
});

export interface AppConfig {
  nodeEnv: string;
  isProduction: boolean;
  databaseUrl: string;
  interakt: { apiKey: string; webhookSecret: string; verifyMode: "hmac" | "off"; apiBase: string };
  llmBackend: "claude-code" | "fake";
  claude: {
    oauthToken?: string;
    tokenIssuedAt?: string;
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    maxTurns: number;
    turnTimeoutMs: number;
    homeDir: string;
  };
  helplinePhone: string;
  websiteUrl: string;
  admin: { password: string; sessionSecret: string };
  workerConcurrency: number;
  logLevel: string;
  logRawWebhooks: boolean;
}

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  cached = {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    databaseUrl: e.DATABASE_URL,
    interakt: {
      apiKey: e.INTERAKT_API_KEY,
      webhookSecret: e.INTERAKT_WEBHOOK_SECRET,
      verifyMode: e.INTERAKT_WEBHOOK_VERIFY_MODE,
      apiBase: e.INTERAKT_API_BASE,
    },
    llmBackend: e.LLM_BACKEND,
    claude: {
      oauthToken: e.CLAUDE_CODE_OAUTH_TOKEN,
      tokenIssuedAt: e.LLM_TOKEN_ISSUED_AT,
      model: e.LLM_MODEL,
      effort: e.LLM_EFFORT,
      maxTurns: e.LLM_MAX_TURNS,
      turnTimeoutMs: e.LLM_TURN_TIMEOUT_MS,
      homeDir: e.LLM_HOME_DIR,
    },
    helplinePhone: e.HELPLINE_PHONE,
    websiteUrl: e.WEBSITE_URL,
    admin: { password: e.ADMIN_PASSWORD, sessionSecret: e.SESSION_SECRET },
    workerConcurrency: e.WORKER_CONCURRENCY,
    logLevel: e.LOG_LEVEL,
    logRawWebhooks: e.LOG_RAW_WEBHOOKS === "1",
  };
  return cached;
}

/** Tests mutate process.env between cases; call this to drop the memo. */
export function resetConfigForTests(): void {
  cached = null;
}
