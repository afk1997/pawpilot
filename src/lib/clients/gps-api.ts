/**
 * Client for Arham's ambulance GPS API.
 *
 * The exact contract isn't finalized; this client codes the minimum we need
 * (current lat/lng for one or more ambulance ids) and degrades gracefully
 * when the API is unavailable — callers fall back to directory-only ranking.
 */

export interface AmbulancePosition {
  ambulance_id: string;
  lat: number;
  lng: number;
  available?: boolean;
  reported_at?: string;
}

const BASE = process.env.GPS_API_BASE;
const KEY = process.env.GPS_API_KEY;

function authHeaders(): Record<string, string> {
  if (!KEY) return {};
  return { Authorization: `Bearer ${KEY}` };
}

/** Get current position for a list of ambulance ids. Skips ambulances the API can't locate. */
export async function getPositions(ambulanceIds: string[]): Promise<AmbulancePosition[]> {
  if (!BASE || ambulanceIds.length === 0) return [];
  const url = new URL("/positions", BASE);
  url.searchParams.set("ids", ambulanceIds.join(","));
  try {
    const res = await fetch(url.toString(), { headers: { ...authHeaders() } });
    if (!res.ok) return [];
    const body = (await res.json()) as { positions?: AmbulancePosition[] } | AmbulancePosition[];
    return Array.isArray(body) ? body : body.positions ?? [];
  } catch (e) {
    console.warn("GPS API fetch threw:", e);
    return [];
  }
}

/** Haversine distance in km. Used to rank candidates after fetching positions. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
