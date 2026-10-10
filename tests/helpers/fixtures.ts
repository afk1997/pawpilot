import { getDb } from "@/server/db/client";
import { operators, ambulances, clinics } from "@/server/db/schema";

export interface DirectoryIds {
  arhamOperatorId: string;
  blueCrossOperatorId: string;
  hopeOperatorId: string;
  ghatkopar: string; malad: string; andheri: string; bandra: string; chembur: string; mulund: string;
  rajkotA: string; rajkotB: string; surat: string; bengaluru: string; puneA: string; puneB: string;
  clinicSurat: string;
  /** A hospital, in the clinics table like the real directory's: Ghatkopar, with published hours, an address and a map link. */
  hospitalGhatkopar: string;
}

/** Hours as the directory writes them for the Mumbai units (an en dash, the time zone named). */
export const MUMBAI_HOURS = "10am–7pm IST";
/** The Ghatkopar hospital's hours, as the directory writes them. */
export const HOSPITAL_HOURS = "10am–11pm IST";
/** The Ghatkopar hospital's address and Google Maps link (5-decimal coordinates), as the directory writes them. */
export const HOSPITAL_ADDRESS = "Rajawadi Rd Number 1, Rajawadi Colony, Ghatkopar East, Mumbai 400077";
export const HOSPITAL_MAP = "https://maps.google.com/?q=19.07948,72.90119";

/**
 * Minimal directory that exercises every matcher tier and both operator kinds. The Ghatkopar unit publishes hours, and the
 * clinics table holds a clinic (Surat, with no map link) and a hospital (Ghatkopar, with hours, an address and a map link),
 * as the real directory does.
 */
export async function seedDirectory(): Promise<DirectoryIds> {
  const db = getDb();
  const [arham] = await db.insert(operators).values({ name: "Arham Yuva Seva Group", isArham: true }).returning();
  const [blue] = await db.insert(operators).values({ name: "Blue Cross", isArham: false }).returning();
  const [hope] = await db.insert(operators).values({ name: "Hope for Indies Trust", isArham: false }).returning();

  const amb = async (v: {
    label: string; city: string; area: string | null; state: string; phone: string; areas: string[]; op: string; hours?: string;
  }) => {
    const [r] = await db
      .insert(ambulances)
      .values({
        operatorId: v.op, label: v.label, city: v.city, area: v.area, state: v.state,
        phone: v.phone, phoneRaw: v.phone, areasCovered: v.areas, hours: v.hours ?? null,
      })
      .returning();
    return r.id;
  };

  const ids: DirectoryIds = {
    arhamOperatorId: arham.id, blueCrossOperatorId: blue.id, hopeOperatorId: hope.id,
    ghatkopar: await amb({ label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "Maharashtra", phone: "+917000000001", areas: ["Ghatkopar", "Vikhroli", "Kurla"], op: arham.id, hours: MUMBAI_HOURS }),
    malad: await amb({ label: "Mumbai - Malad", city: "Mumbai", area: "Malad", state: "Maharashtra", phone: "+917000000002", areas: ["Malad", "Kandivali"], op: arham.id }),
    andheri: await amb({ label: "Mumbai - Andheri", city: "Mumbai", area: "Andheri", state: "Maharashtra", phone: "+917000000003", areas: ["Andheri", "Jogeshwari", "Vile Parle"], op: arham.id }),
    bandra: await amb({ label: "Mumbai - Bandra", city: "Mumbai", area: "Bandra", state: "Maharashtra", phone: "+917000000004", areas: ["Bandra", "Khar", "Santacruz"], op: arham.id }),
    chembur: await amb({ label: "Mumbai - Chembur", city: "Mumbai", area: "Chembur", state: "Maharashtra", phone: "+917000000005", areas: ["Chembur", "Govandi"], op: arham.id }),
    mulund: await amb({ label: "Mumbai - Mulund", city: "Mumbai", area: "Mulund", state: "Maharashtra", phone: "+917000000006", areas: ["Mulund", "Bhandup", "Nahur"], op: arham.id }),
    rajkotA: await amb({ label: "Rajkot - Blue Cross", city: "Rajkot", area: null, state: "Gujarat", phone: "+919876500001", areas: ["Rajkot"], op: blue.id }),
    rajkotB: await amb({ label: "Rajkot - Hope", city: "Rajkot", area: null, state: "Gujarat", phone: "+919876500002", areas: ["Rajkot"], op: hope.id }),
    surat: await amb({ label: "Surat", city: "Surat", area: null, state: "Gujarat", phone: "+919876500003", areas: ["Surat", "Vesu", "Varachha"], op: arham.id }),
    bengaluru: await amb({ label: "Bengaluru", city: "Bengaluru", area: null, state: "Karnataka", phone: "+919876500004", areas: ["Bengaluru"], op: arham.id }),
    puneA: await amb({ label: "Pune - PMC", city: "Pune", area: "PMC", state: "Maharashtra", phone: "+919876500005", areas: ["Kothrud", "Karve Nagar", "Shivajinagar"], op: arham.id }),
    puneB: await amb({ label: "Pune - PCMC", city: "Pune", area: "PCMC", state: "Maharashtra", phone: "+919876500006", areas: ["Pimpri", "Chinchwad", "Hinjewadi"], op: arham.id }),
    clinicSurat: "",
    hospitalGhatkopar: "",
  };
  const [clinic] = await db
    .insert(clinics)
    .values({ operatorId: arham.id, label: "Arham Clinic Surat", city: "Surat", area: "Vesu", state: "Gujarat", phone: "+912612345678", address: "Vesu Main Road", hours: "9am-7pm" })
    .returning();
  ids.clinicSurat = clinic.id;
  const [hospital] = await db
    .insert(clinics)
    .values({
      operatorId: arham.id, label: "Mumbai - Ghatkopar Hospital", city: "Mumbai", area: "Ghatkopar", state: "Maharashtra", phone: "+917000000020",
      address: HOSPITAL_ADDRESS, hours: HOSPITAL_HOURS, mapsUrl: HOSPITAL_MAP,
    })
    .returning();
  ids.hospitalGhatkopar = hospital.id;
  return ids;
}
