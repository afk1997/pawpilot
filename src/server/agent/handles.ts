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
  /** Own keys only, so names like "constructor" or "__proto__" never resolve to inherited members. */
  resolve(handle: string): { kind: HandleKind; id: string } | undefined {
    return Object.hasOwn(this.map, handle) ? this.map[handle] : undefined;
  }
  handles(): string[] {
    return Object.keys(this.map);
  }
  toJSON(): HandleMap {
    return { ...this.map };
  }
}

export const TOKEN_RE = /\{\{(AMB|CLINIC|PHONE):([A-Za-z0-9_-]+)\}\}/g;

/** Scans a fresh copy of TOKEN_RE: matchAll resumes from a regex's lastIndex, which a caller's TOKEN_RE.test/exec leaves advanced. */
export function extractTokens(text: string): { kind: "AMB" | "CLINIC" | "PHONE"; value: string; raw: string }[] {
  const out: { kind: "AMB" | "CLINIC" | "PHONE"; value: string; raw: string }[] = [];
  for (const m of text.matchAll(new RegExp(TOKEN_RE.source, TOKEN_RE.flags))) out.push({ kind: m[1] as "AMB" | "CLINIC" | "PHONE", value: m[2], raw: m[0] });
  return out;
}
