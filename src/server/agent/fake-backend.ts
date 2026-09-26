import type { BackendErrorKind, LLMBackend, StructuredReply, TurnInput, TurnResult } from "./types";

export function okReply(partial: Partial<StructuredReply> & { reply: string }): TurnResult {
  return {
    ok: true,
    structured: { language: "en", intent: "other", location: { city: null, area: null }, needs_human: false, notes: null, ...partial },
    usage: { input_tokens: 10, output_tokens: 5 },
    latencyMs: 1,
    sessionId: "fake-session",
    model: "fake",
    costUsd: 0,
  };
}

export function errorResult(kind: BackendErrorKind, message = kind, retryAfter: Date | null = null): TurnResult {
  return { ok: false, kind, message, retryAfter, latencyMs: 1, sessionId: null };
}

type Step = TurnResult | ((input: TurnInput) => TurnResult | Promise<TurnResult>);

/** Scripted backend. Each call consumes the next step; the last step repeats. */
export class FakeBackend implements LLMBackend {
  readonly name = "fake";
  calls: TurnInput[] = [];
  private script: Step[];
  constructor(script: Step[] = []) {
    this.script = [...script];
  }
  async runTurn(input: TurnInput): Promise<TurnResult> {
    this.calls.push(input);
    const step = this.script.length > 1 ? this.script.shift()! : this.script[0];
    if (!step) {
      const last = input.prompt.split("\n").filter((l) => l.startsWith("[")).pop() ?? "";
      return okReply({ reply: `Fake backend reply to: ${last.slice(0, 80)}` });
    }
    return typeof step === "function" ? step(input) : step;
  }
}
