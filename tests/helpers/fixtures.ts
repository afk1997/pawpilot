import { getDb } from "@/server/db/client";
import { operators, ambulances, clinics } from "@/server/db/schema";

export interface DirectoryIds {
  arhamOperatorId: string;
  blueCrossOperatorId: string;
  hopeOperatorId: string;
  ghatkopar: string; malad: string; andheri: string; bandra: string; chembur: string; mulund: string;
  rajkotA: string; rajkotB: string; surat: string; bengaluru: string; puneA: string; puneB: string;
  clinicSurat: string;
}

/** Minimal directory that exercises every matcher tier and both operator kinds. */
export async function seedDirectory(): Promise<DirectoryIds> {
  const db = getDb();
  const [arham] = await db.insert(operators).values({ name: "Arham Yuva Seva Group", isArham: true }).returning();
  const [blue] = await db.insert(operators).values({ name: "Blue Cross", isArham: false }).returning();
  const [hope] = await db.insert(operators).values({ name: "Hope for Indies Trust", isArham: false }).returning();

  const amb = async (v: {
    label: string; city: string; area: string | null; state: string; phone: string; areas: string[]; op: string;
  }) => {
    const [r] = await db
      .insert(ambulances)
      .values({
        operatorId: v.op, label: v.label, city: v.city, area: v.area, state: v.state,
        phone: v.phone, phoneRaw: v.phone, areasCovered: v.areas,
      })
      .returning();
    return r.id;
  };

  const ids: DirectoryIds = {
    arhamOperatorId: arham.id, blueCrossOperatorId: blue.id, hopeOperatorId: hope.id,
    ghatkopar: await amb({ label: "Mumbai - Ghatkopar", city: "Mumbai", area: "Ghatkopar", state: "Maharashtra", phone: "+917662005404", areas: ["Ghatkopar", "Vikhroli", "Kurla"], op: arham.id }),
    malad: await amb({ label: "Mumbai - Malad", city: "Mumbai", area: "Malad", state: "Maharashtra", phone: "+917662005405", areas: ["Malad", "Kandivali"], op: arham.id }),
    andheri: await amb({ label: "Mumbai - Andheri", city: "Mumbai", area: "Andheri", state: "Maharashtra", phone: "+917662005406", areas: ["Andheri", "Jogeshwari", "Vile Parle"], op: arham.id }),
    bandra: await amb({ label: "Mumbai - Bandra", city: "Mumbai", area: "Bandra", state: "Maharashtra", phone: "+917662005407", areas: ["Bandra", "Khar", "Santacruz"], op: arham.id }),
    chembur: await amb({ label: "Mumbai - Chembur", city: "Mumbai", area: "Chembur", state: "Maharashtra", phone: "+917662005408", areas: ["Chembur", "Govandi"], op: arham.id }),
    mulund: await amb({ label: "Mumbai - Mulund", city: "Mumbai", area: "Mulund", state: "Maharashtra", phone: "+917662005409", areas: ["Mulund", "Bhandup", "Nahur"], op: arham.id }),
    rajkotA: await amb({ label: "Rajkot - Blue Cross", city: "Rajkot", area: null, state: "Gujarat", phone: "+919876500001", areas: ["Rajkot"], op: blue.id }),
    rajkotB: await amb({ label: "Rajkot - Hope", city: "Rajkot", area: null, state: "Gujarat", phone: "+919876500002", areas: ["Rajkot"], op: hope.id }),
    surat: await amb({ label: "Surat", city: "Surat", area: null, state: "Gujarat", phone: "+919876500003", areas: ["Surat", "Vesu", "Varachha"], op: arham.id }),
    bengaluru: await amb({ label: "Bengaluru", city: "Bengaluru", area: null, state: "Karnataka", phone: "+919876500004", areas: ["Bengaluru"], op: arham.id }),
    puneA: await amb({ label: "Pune - PMC", city: "Pune", area: "PMC", state: "Maharashtra", phone: "+919876500005", areas: ["Kothrud", "Karve Nagar", "Shivajinagar"], op: arham.id }),
    puneB: await amb({ label: "Pune - PCMC", city: "Pune", area: "PCMC", state: "Maharashtra", phone: "+919876500006", areas: ["Pimpri", "Chinchwad", "Hinjewadi"], op: arham.id }),
    clinicSurat: "",
  };
  const [clinic] = await db
    .insert(clinics)
    .values({ operatorId: arham.id, label: "Arham Clinic Surat", city: "Surat", area: "Vesu", state: "Gujarat", phone: "+912612345678", address: "Vesu Main Road", hours: "9am-7pm" })
    .returning();
  ids.clinicSurat = clinic.id;
  return ids;
}
