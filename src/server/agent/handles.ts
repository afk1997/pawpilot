import { createHash } from "node:crypto";

export type HandleKind = "ambulance" | "clinic";
export type HandleMap = Record<string, { kind: HandleKind; id: string }>;

/** Stable within a conversation, opaque across conversations. */
export function makeHandle(kind: HandleKind, conversationId: string, entityId: string): string {
  const hex = createHash("sha256").update(`${conversationId}:${kind}:${entityId}`).digest("hex");
  // Letters only (each hex nibble 0-f becomes a-p), so a handle never holds a digit run that could pass for a phone number.
  const letters = hex.slice(0, 8).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
  return `${kind === "ambulance" ? "amb" : "cli"}_${letters}`;
}

export class HandleRegistry {
  private map: HandleMap;
  constructor(private readonly conversationId: string, initial: HandleMap = {}) {
    this.map = { ...initial };
  }
  ambulance(id: string): string {
    return this.issue("ambulance", id);
  }
  clinic(id: string): string {
    return this.issue("clinic", id);
  }
  /** Case-insensitive, since handles are always lowercase; own keys only, so "constructor" or "__proto__" never resolve to inherited members. */
  resolve(handle: string): { kind: HandleKind; id: string } | undefined {
    const key = handle.toLowerCase();
    return Object.hasOwn(this.map, key) ? this.map[key] : undefined;
  }
  handles(): string[] {
    return Object.keys(this.map);
  }
  toJSON(): HandleMap {
    return { ...this.map };
  }
  /** A handle already held by a different entity throws: a failure is recoverable, handing out someone else's number is not. */
  private issue(kind: HandleKind, id: string): string {
    const h = makeHandle(kind, this.conversationId, id);
    if (Object.hasOwn(this.map, h) && this.map[h].id !== id) throw new Error("handle collision");
    this.map[h] = { kind, id };
    return h;
  }
}

/**
 * What a token stands for: AMB a unit's number, CLINIC a hospital's or clinic's number, MAPS a hospital's or clinic's
 * Google Maps link (the same cli_ handle as its CLINIC token), PHONE the helpline's or a static content number.
 */
export type TokenKind = "AMB" | "CLINIC" | "MAPS" | "PHONE";

export const TOKEN_RE = /\{\{(AMB|CLINIC|MAPS|PHONE):([A-Za-z0-9_-]+)\}\}/g;

/** Scans a fresh copy of TOKEN_RE: matchAll resumes from a regex's lastIndex, which a caller's TOKEN_RE.test/exec leaves advanced. */
export function extractTokens(text: string): { kind: TokenKind; value: string; raw: string }[] {
  const out: { kind: TokenKind; value: string; raw: string }[] = [];
  for (const m of text.matchAll(new RegExp(TOKEN_RE.source, TOKEN_RE.flags))) out.push({ kind: m[1] as TokenKind, value: m[2], raw: m[0] });
  return out;
}
