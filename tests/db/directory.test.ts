import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { ambulances } from "@/server/db/schema";
import { resetDb } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { loadActiveAmbulances, loadActiveClinics, getAmbulancesByIds, getClinicsByIds } from "@/server/directory/repo";
import { ingestDirectory, parseDirectoryCsv } from "@/server/directory/ingest";
import { getCoverageSummary, resetCoverageCache } from "@/server/directory/coverage";

describe("directory repo", () => {
  beforeEach(async () => { await resetDb(); resetCoverageCache(); });

  it("loads active ambulances joined with their operator", async () => {
    const ids = await seedDirectory();
    const rows = await loadActiveAmbulances();
    const rajkot = rows.filter((r) => r.city === "Rajkot");
    expect(rajkot.map((r) => r.operatorName).sort()).toEqual(["Blue Cross", "Hope for Indies Trust"]);
    expect(rajkot.every((r) => r.operatorIsArham === false)).toBe(true);
    const byId = await getAmbulancesByIds([ids.ghatkopar]);
    expect(byId.get(ids.ghatkopar)?.phone).toBe("+917000000001");
    expect((await loadActiveClinics())[0].label).toBe("Arham Clinic Surat");
    const clinicById = await getClinicsByIds([ids.clinicSurat]);
    expect(clinicById.get(ids.clinicSurat)).toMatchObject({ label: "Arham Clinic Surat", phone: "+912612345678", hours: "9am-7pm" });
  });

  it("builds and caches the coverage summary", async () => {
    const ids = await seedDirectory();
    const s1 = await getCoverageSummary();
    expect(s1).toContain("- Mumbai:");
    expect(s1).toContain("- Pune: PCMC, PMC");
    expect(s1).toContain("- Bengaluru: whole city (1 unit)");
    // A directory change shows up only once the hour is over or the cache is reset.
    await getDb().update(ambulances).set({ active: false }).where(eq(ambulances.id, ids.bengaluru));
    expect(await getCoverageSummary()).toBe(s1);
    expect(await getCoverageSummary(Date.now() + 60 * 60 * 1000)).not.toContain("- Bengaluru:");
    await getDb().update(ambulances).set({ active: true }).where(eq(ambulances.id, ids.bengaluru));
    resetCoverageCache();
    expect(await getCoverageSummary()).toBe(s1);
  });

  it("ingests a CSV idempotently", async () => {
    const csv = `Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By
Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,"Ghatkopar, Vikhroli",Animal Ambulance,Arham Yuva Seva Group
Ambulance,Rajkot - ALAI,Rajkot,ALAI Trust,Gujarat,9876500001,Entire City,Animal Ambulance,ALAI Trust
Clinic,Arham Clinic Surat,"Surat, Gujarat",Vesu,Gujarat,02612345678,,Clinic,Arham Yuva Seva Group`;
    const first = await ingestDirectory(parseDirectoryCsv(csv));
    expect(first).toMatchObject({ operators: 2, ambulancesInserted: 2, ambulancesUpdated: 0, clinicsInserted: 1 });
    const second = await ingestDirectory(parseDirectoryCsv(csv));
    expect(second).toMatchObject({ ambulancesInserted: 0, ambulancesUpdated: 2, clinicsUpdated: 1 });
    const rows = await loadActiveAmbulances();
    const alai = rows.find((r) => r.label === "Rajkot - ALAI")!;
    expect(alai.area).toBeNull();
    expect(alai.areasCovered).toEqual(["Rajkot"]);
    expect(alai.operatorIsArham).toBe(false);
    const ghatkopar = rows.find((r) => r.label === "Mumbai - Ghatkopar")!;
    expect(ghatkopar).toMatchObject({ area: "Ghatkopar", areasCovered: ["Ghatkopar", "Vikhroli"], phone: "+917000000001", operatorIsArham: true });
    expect(await loadActiveClinics()).toMatchObject([{ label: "Arham Clinic Surat", city: "Surat", area: "Vesu", phone: "+912612345678" }]);
  });
});
