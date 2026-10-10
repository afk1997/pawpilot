/**
 * The directory's two kinds of link and the website they belong to, in one leaf module that imports nothing: the ingest
 * (directory/ingest.ts), the renderer and the clinic card (messages/cards.ts), find_clinics (agent/tools.ts) and the
 * config's default all read these definitions.
 */

/** The public website the welcome, the menu, the prompt and the directory's pages link to, when WEBSITE_URL is not set. */
export const DEFAULT_WEBSITE_URL = "https://alwayscare.org";

/**
 * A hospital's or clinic's map link as the directory may hold it, and so the only kind of link code ever puts into a
 * reply: https://maps.google.com/?q=<lat>,<lng> with at most six decimals each, so no digit group reaches seven. No other
 * host, path, query or text.
 */
export const MAPS_URL_RE = /^https:\/\/maps\.google\.com\/\?q=-?\d{1,2}\.\d{1,6},-?\d{1,3}\.\d{1,6}$/;

/** The website's host (from WEBSITE_URL's origin), lower case, without a leading "www.". */
export function websiteHost(websiteUrl: string): string {
  return new URL(websiteUrl).host.toLowerCase().replace(/^www\./, "");
}

/** A page on the website: https://, the website's host with or without "www.", then a path of letters, digits, "/", "_" and "-". */
export function websitePageRe(websiteUrl: string): RegExp {
  const host = websiteHost(websiteUrl).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^https://(?:www\\.)?${host}/[A-Za-z0-9/_-]*$`);
}

/** The directory's map link trimmed, when it is one MAPS_URL_RE link; null otherwise, so nothing else is ever inserted. */
export function mapsLink(url: string | null | undefined): string | null {
  const link = (url ?? "").trim();
  return MAPS_URL_RE.test(link) ? link : null;
}

/** The directory's page link trimmed, when it is a page on the website; null otherwise. */
export function websitePage(url: string | null | undefined, websiteUrl: string): string | null {
  const link = (url ?? "").trim();
  return websitePageRe(websiteUrl).test(link) ? link : null;
}
