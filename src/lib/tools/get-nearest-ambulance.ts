/**
 * Tool: get_nearest_ambulance
 *
 * Used as a tiebreaker when find_ambulance_by_area returns multiple
 * candidates AND the reporter has shared a WhatsApp location pin (or a
 * geocoded area).
 *
 * Calls the GPS API to fetch each candidate's current position, ranks by
 * Haversine distance, returns the nearest unit. Falls back to the first
 * candidate if the GPS API is unavailable (degraded mode).
 */
import { z } from "zod";
import { tool } from "ai";
import { supabase } from "../supabase";
import { getPositions, haversineKm } from "../clients/gps-api";

export const getNearestAmbulanceParams = z.object({
  lat: z.number().describe("Reporter's latitude (from WhatsApp location pin)."),
  lng: z.number().describe("Reporter's longitude (from WhatsApp location pin)."),
  candidate_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Optional list of ambulance ids to rank among. If omitted, all active ambulances are considered."
    ),
});

export type GetNearestAmbulanceInput = z.infer<typeof getNearestAmbulanceParams>;

export interface NearestAmbulanceResult {
  id: string;
  label: string;
  driver_phone: string;
  city: string;
  state: string;
  area: string | null;
  operator_name: string;
  operator_is_arham: boolean;
  distance_km: number | null;
  degraded: boolean;
}

export async function getNearestAmbulance(
  input: GetNearestAmbulanceInput
): Promise<NearestAmbulanceResult | null> {
  const { lat, lng, candidate_ids } = input;

  let q = supabase
    .from("ambulances")
    .select(
      "id, label, phone, city, state, area, ngo_operators(name, is_arham)"
    )
    .eq("active", true);

  if (candidate_ids && candidate_ids.length > 0) {
    q = q.in("id", candidate_ids);
  }

  const { data: ambulances, error } = await q;
  if (error || !ambulances || ambulances.length === 0) return null;

  const positions = await getPositions(ambulances.map((a) => a.id as string));
  const byId = new Map(positions.map((p) => [p.ambulance_id, p]));

  // Filter to those we have positions for; rank by distance.
  const ranked = ambulances
    .map((a) => {
      const op = (a as unknown as { ngo_operators?: { name?: string; is_arham?: boolean } })
        .ngo_operators;
      const pos = byId.get(a.id as string);
      const distance_km = pos
        ? haversineKm({ lat, lng }, { lat: pos.lat, lng: pos.lng })
        : null;
      return {
        id: a.id as string,
        label: a.label as string,
        driver_phone: a.phone as string,
        city: a.city as string,
        state: a.state as string,
        area: (a.area as string | null) ?? null,
        operator_name: op?.name ?? "Arham Yuva Seva Group",
        operator_is_arham: op?.is_arham ?? true,
        distance_km,
        available: pos?.available ?? true,
      };
    })
    // Prefer available units; among them, nearest first; ones without GPS fall to the bottom.
    .sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1;
      if (a.distance_km === null && b.distance_km === null) return 0;
      if (a.distance_km === null) return 1;
      if (b.distance_km === null) return -1;
      return a.distance_km - b.distance_km;
    });

  if (ranked.length === 0) return null;

  const top = ranked[0];
  const degraded = positions.length === 0;

  return {
    id: top.id,
    label: top.label,
    driver_phone: top.driver_phone,
    city: top.city,
    state: top.state,
    area: top.area,
    operator_name: top.operator_name,
    operator_is_arham: top.operator_is_arham,
    distance_km: top.distance_km,
    degraded,
  };
}

export const getNearestAmbulanceTool = tool({
  description:
    "Pick the nearest ambulance given a location pin. Use as a tiebreaker when find_ambulance_by_area returns multiple candidates and the reporter shared a WhatsApp pin. Returns one row or null. May be degraded if the GPS API is down (degraded:true).",
  inputSchema: getNearestAmbulanceParams,
  execute: async (input) => getNearestAmbulance(input),
});
