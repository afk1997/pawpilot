/**
 * Multi-provider model resolver. The `AI_MODEL` env var doubles as the
 * routing key — its `provider/model` form picks both the provider and the
 * specific model.
 *
 * Examples:
 *   anthropic/claude-sonnet-4-6   → @ai-sdk/anthropic, model claude-sonnet-4-6
 *   anthropic/claude-opus-4-7     → @ai-sdk/anthropic, model claude-opus-4-7
 *   openai/gpt-5.1                → @ai-sdk/openai, model gpt-5.1
 *   google/gemini-2.5-pro         → @ai-sdk/google, model gemini-2.5-pro
 *   deepseek/deepseek-chat        → DeepSeek (OpenAI-compatible endpoint)
 *   openrouter/<provider>/<model> → OpenRouter as a meta-provider
 *
 * Switching providers is an env-var change only. No code change.
 *
 * Future: when we want native fallbacks + observability, swap this file
 * for Vercel AI Gateway (`provider/model` strings work the same way under
 * the gateway, with a single AI_GATEWAY_API_KEY).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

interface ResolvedModel {
  provider: string;
  modelName: string;
  model: LanguageModel;
}

let cache: Record<string, ResolvedModel> = {};

export function resolveModel(modelId: string): ResolvedModel {
  if (cache[modelId]) return cache[modelId];

  const slashIdx = modelId.indexOf("/");
  if (slashIdx <= 0) {
    throw new Error(
      `AI_MODEL must be "<provider>/<model>" (e.g. "anthropic/claude-sonnet-4-6"). Got: ${modelId}`
    );
  }
  const provider = modelId.slice(0, slashIdx);
  const modelName = modelId.slice(slashIdx + 1);

  let model: LanguageModel;

  switch (provider) {
    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error(`ANTHROPIC_API_KEY not set (required for ${modelId})`);
      model = createAnthropic({ apiKey })(modelName);
      break;
    }

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error(`OPENAI_API_KEY not set (required for ${modelId})`);
      model = createOpenAI({ apiKey })(modelName);
      break;
    }

    case "google": {
      const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!apiKey)
        throw new Error(`GOOGLE_API_KEY not set (required for ${modelId})`);
      model = createGoogleGenerativeAI({ apiKey })(modelName);
      break;
    }

    case "deepseek": {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) throw new Error(`DEEPSEEK_API_KEY not set (required for ${modelId})`);
      model = createOpenAICompatible({
        name: "deepseek",
        baseURL: "https://api.deepseek.com/v1",
        apiKey,
      })(modelName);
      break;
    }

    case "groq": {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error(`GROQ_API_KEY not set (required for ${modelId})`);
      model = createOpenAICompatible({
        name: "groq",
        baseURL: "https://api.groq.com/openai/v1",
        apiKey,
      })(modelName);
      break;
    }

    case "openrouter": {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey)
        throw new Error(`OPENROUTER_API_KEY not set (required for ${modelId})`);
      model = createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey,
        headers: {
          "HTTP-Referer": "https://arhamalwayscare.org",
          "X-Title": "Arham Always Care WhatsApp Agent",
        },
      })(modelName);
      break;
    }

    case "custom": {
      // Escape hatch — set CUSTOM_AI_BASE_URL + CUSTOM_AI_API_KEY for any
      // OpenAI-compatible endpoint (self-hosted, Together, Fireworks, etc.).
      const baseURL = process.env.CUSTOM_AI_BASE_URL;
      const apiKey = process.env.CUSTOM_AI_API_KEY;
      if (!baseURL || !apiKey)
        throw new Error("CUSTOM_AI_BASE_URL and CUSTOM_AI_API_KEY required for custom provider");
      model = createOpenAICompatible({ name: "custom", baseURL, apiKey })(modelName);
      break;
    }

    default:
      throw new Error(
        `Unknown AI provider "${provider}" in AI_MODEL. Supported: anthropic, openai, google, deepseek, groq, openrouter, custom.`
      );
  }

  const resolved: ResolvedModel = { provider, modelName, model };
  cache[modelId] = resolved;
  return resolved;
}

/** Reset the resolver cache. Useful in tests. */
export function clearProviderCache(): void {
  cache = {};
}
