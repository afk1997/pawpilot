import { eq, inArray, and } from "drizzle-orm";
import { getDb } from "../db/client";
import { ambulances, clinics, operators } from "../db/schema";
import type { DirectoryAmbulance } from "./matcher";

export interface DirectoryClinic {
  id: string;
  label: string;
  city: string;
  area: string | null;
  state: string;
  phone: string;
  address: string | null;
  hours: string | null;
  /** Its Google Maps link (one https link, clinics.maps_url); null or absent: none. Replies carry it as {{MAPS:<handle>}}. */
  mapsUrl?: string | null;
  /** Its page on the website (one https link); null or absent: none. */
  pageUrl?: string | null;
  /** What it offers, as the directory writes it; null or absent: not published. */
  services?: string | null;
  /** What a visitor should know (charges, calling first), as the directory writes it; null or absent: none. */
  notes?: string | null;
}

function toDirectoryAmbulance(r: {
  id: string; label: string; city: string; area: string | null; state: string; areasCovered: string[];
  category: string; phone: string; hours: string | null; operatorName: string | null; operatorIsArham: boolean | null;
}): DirectoryAmbulance {
  return {
    id: r.id, label: r.label, city: r.city, area: r.area, state: r.state, areasCovered: r.areasCovered ?? [],
    category: r.category, phone: r.phone, hours: r.hours,
    operatorName: r.operatorName ?? "Arham Yuva Seva Group", operatorIsArham: r.operatorIsArham ?? true,
  };
}

const ambulanceSelect = {
  id: ambulances.id, label: ambulances.label, city: ambulances.city, area: ambulances.area, state: ambulances.state,
  areasCovered: ambulances.areasCovered, category: ambulances.category, phone: ambulances.phone, hours: ambulances.hours,
  operatorName: operators.name, operatorIsArham: operators.isArham,
};

export async function loadActiveAmbulances(): Promise<DirectoryAmbulance[]> {
  const rows = await getDb()
    .select(ambulanceSelect)
    .from(ambulances)
    .leftJoin(operators, eq(ambulances.operatorId, operators.id))
    .where(eq(ambulances.active, true));
  return rows.map(toDirectoryAmbulance);
}

/** Active units only: a handle issued before an ingest retired its unit must never render that unit's number. */
export async function getAmbulancesByIds(ids: string[]): Promise<Map<string, DirectoryAmbulance>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select(ambulanceSelect)
    .from(ambulances)
    .leftJoin(operators, eq(ambulances.operatorId, operators.id))
    .where(and(inArray(ambulances.id, ids), eq(ambulances.active, true)));
  return new Map(rows.map((r) => [r.id, toDirectoryAmbulance(r)]));
}

const clinicSelect = {
  id: clinics.id, label: clinics.label, city: clinics.city, area: clinics.area, state: clinics.state,
  phone: clinics.phone, address: clinics.address, hours: clinics.hours, mapsUrl: clinics.mapsUrl, pageUrl: clinics.pageUrl,
  services: clinics.services, notes: clinics.notes,
};

export async function loadActiveClinics(): Promise<DirectoryClinic[]> {
  return getDb().select(clinicSelect).from(clinics).where(eq(clinics.active, true));
}

/** Active clinics only, for the same reason as getAmbulancesByIds. */
export async function getClinicsByIds(ids: string[]): Promise<Map<string, DirectoryClinic>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().select(clinicSelect).from(clinics).where(and(inArray(clinics.id, ids), eq(clinics.active, true)));
  return new Map(rows.map((r) => [r.id, r]));
}
