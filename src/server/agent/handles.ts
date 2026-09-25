import { createHash } from "node:crypto";

export type HandleKind = "ambulance" | "clinic";
export type HandleMap = Record<string, { kind: HandleKind; id: string }>;

/** Stable within a conversation, opaque across conversations. */
export function makeHandle(kind: HandleKind, conversationId: string, entityId: string): string {
  const hex = createHash("sha256").update(`${conversationId}:${kind}:${entityId}`).digest("hex").slice(0, 8);
  return `${kind === "ambulance" ? "amb" : "cli"}_${hex}`;
}

export class HandleRegistry {
  private map: HandleMap;
  constructor(private readonly conversationId: string, initial: HandleMap = {}) {
    this.map = { ...initial };
  }
  ambulance(id: string): string {
    const h = makeHandle("ambulance", this.conversationId, id);
    this.map[h] = { kind: "ambulance", id };
    return h;
  }
  clinic(id: string): string {
    const h = makeHandle("clinic", this.conversationId, id);
    this.map[h] = { kind: "clinic", id };
    return h;
  }
  resolve(handle: string): { kind: HandleKind; id: string } | undefined {
    return this.map[handle];
  }
  handles(): string[] {
    return Object.keys(this.map);
  }
  toJSON(): HandleMap {
    return { ...this.map };
  }
}

export const TOKEN_RE = /\{\{(AMB|CLINIC|PHONE):([A-Za-z0-9_-]+)\}\}/g;

export function extractTokens(text: string): { kind: "AMB" | "CLINIC" | "PHONE"; value: string; raw: string }[] {
  const out: { kind: "AMB" | "CLINIC" | "PHONE"; value: string; raw: string }[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ kind: m[1] as "AMB" | "CLINIC" | "PHONE", value: m[2], raw: m[0] });
  return out;
}
