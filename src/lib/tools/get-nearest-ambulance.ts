/**
 * Tool: get_nearest_ambulance
 *
 * Tiebreaker when find_ambulance_by_area returns multiple candidates AND
 * the reporter has shared a WhatsApp location pin. Calls GPS API, ranks by
 * Haversine distance, returns one unit with deterministic card fields.
 *
 * Falls back gracefully when GPS API is unavailable (degraded:true).
 */
import { z } from "zod";
import { tool } from "ai";
import { supabase } from "../supabase";
import { getPositions, haversineKm } from "../clients/gps-api";
import { buildAmbulanceCard, formatIndianPhone } from "../ambulance-card";
import type { Language } from "../types";

export const getNearestAmbulanceParams = z.object({
  lat: z.number().describe("Reporter's latitude (from WhatsApp location pin)."),
  lng: z.number().describe("Reporter's longitude (from WhatsApp location pin)."),
  candidate_ids: z
    .array(z.string())
    .optional()
    .describe("Optional list of ambulance ids to rank among. Omit to consider all active ambulances."),
  language: z
    .enum(["en", "hi", "mr", "gu"])
    .optional()
    .describe("Reporter's language; used to localize the operator suffix."),
});

export type GetNearestAmbulanceInput = z.infer<typeof getNearestAmbulanceParams>;

export interface NearestAmbulanceResult {
  id: string;
  label: string;
  city: string;
  state: string;
  area: string | null;
  operator_name: string;
  operator_is_arham: boolean;
  phone: string;
  phone_formatted: string;
  display_name: string;
  operator_suffix: string | null;
  distance_km: number | null;
  degraded: boolean;
}

export async function getNearestAmbulance(
  input: GetNearestAmbulanceInput
): Promise<NearestAmbulanceResult | null> {
  const { lat, lng, candidate_ids } = input;
  const lang: Language = (input.language as Language | undefined) ?? "en";

  let q = supabase
    .from("ambulances")
    .select("id, label, phone, city, state, area, ngo_operators(name, is_arham)")
    .eq("active", true);

  if (candidate_ids && candidate_ids.length > 0) {
    q = q.in("id", candidate_ids);
  }

  const { data: ambulances, error } = await q;
  if (error || !ambulances || ambulances.length === 0) return null;

  const positions = await getPositions(ambulances.map((a) => a.id as string));
  const byId = new Map(positions.map((p) => [p.ambulance_id, p]));

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
        phone: a.phone as string,
        city: a.city as string,
        state: a.state as string,
        area: (a.area as string | null) ?? null,
        operator_name: op?.name ?? "Arham Yuva Seva Group",
        operator_is_arham: op?.is_arham ?? true,
        distance_km,
        available: pos?.available ?? true,
      };
    })
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
  const card = buildAmbulanceCard(
    {
      city: top.city,
      area: top.area,
      phone: top.phone,
      operator_name: top.operator_name,
      operator_is_arham: top.operator_is_arham,
    },
    lang
  );

  return {
    id: top.id,
    label: top.label,
    city: top.city,
    state: top.state,
    area: top.area,
    operator_name: top.operator_name,
    operator_is_arham: top.operator_is_arham,
    phone: top.phone,
    phone_formatted: formatIndianPhone(top.phone),
    display_name: card.display_name,
    operator_suffix: card.operator_suffix,
    distance_km: top.distance_km,
    degraded,
  };
}

export const getNearestAmbulanceTool = tool({
  description:
    "Pick the nearest ambulance given a location pin. Use only when the reporter shared a WhatsApp location pin AND find_ambulance_by_area returned multiple candidates. Returns one row with `display_name` and `phone_formatted` ready to paste verbatim, or null. May be degraded if the GPS API is down (degraded:true).",
  inputSchema: getNearestAmbulanceParams,
  execute: async (input) => getNearestAmbulance(input),
});
