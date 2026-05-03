import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function cleanString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

export function slugify(value: string): string {
  return cleanString(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/₹/g, "rs ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
}

export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return null;
}

export function extractFirstUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>)]+/i);
  return match ? match[0].replace(/[.,;!?]+$/, "") : null;
}

export function extractEmail(value: string): string | null {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : null;
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function inferValueType(value: string): "text" | "url" | "email" | "phone" | "money" | "boolean" {
  if (extractFirstUrl(value)) return "url";
  if (extractEmail(value)) return "email";
  if (normalizePhone(value)) return "phone";
  if (/₹|\brs\.?\b|\binr\b/i.test(value)) return "money";
  if (/^(yes|no|true|false)$/i.test(value.trim())) return "boolean";
  return "text";
}

export function splitList(value: string): string[] {
  return cleanString(value)
    .split(/[,;\n]/)
    .map((item) => cleanString(item))
    .filter(Boolean);
}

export function unsafeTemplateReason(value: string): string | null {
  const unsafe = [
    /\bwe'?re on it\b/i,
    /\bwe are on it\b/i,
    /\bour team will reach\b/i,
    /\bteam will reach\b/i,
    /\bwill reach within\b/i,
    /\bwe'?re sending\b/i,
    /\bwe are sending\b/i,
    /\bon the way\b/i,
    /\bconfirm dispatch\b/i,
    /\bdispatch(?:ed|ing)?\b/i,
  ];
  const hit = unsafe.find((pattern) => pattern.test(value));
  return hit ? hit.source : null;
}

export function hasPlaceholder(value: string): boolean {
  return /\b(todo|tbd|fixme|lorem ipsum)\b|{[A-Z0-9_ -]+}|\[[A-Z0-9_ -]+\]/i.test(value);
}

export function parseCityArea(location: string, cityShort?: string): { city: string; area: string | null } {
  const city = cleanString(cityShort) || cleanString(location).split(/\s+-\s+/, 1)[0] || cleanString(location);
  const normalizedLocation = cleanString(location);
  const prefix = new RegExp(`^${escapeRegExp(city)}\\s*[-–—]\\s*`, "i");
  const area = normalizedLocation.replace(prefix, "").trim();
  if (!area || area.toLowerCase() === city.toLowerCase()) return { city, area: null };
  return { city, area };
}

export function chunkText(value: string, maxLength = 900): string[] {
  const text = cleanString(value);
  if (text.length <= maxLength) return text ? [text] : [];
  const paragraphs = text.split(/\n{2,}/).map(cleanString).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (`${current}\n\n${paragraph}`.trim().length > maxLength && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = `${current}\n\n${paragraph}`.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
