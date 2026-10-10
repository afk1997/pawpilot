import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { ambulances, clinics, operators } from "@/server/db/schema";
import { resetDb } from "../helpers/db";
import { seedDirectory } from "../helpers/fixtures";
import { loadActiveAmbulances, loadActiveClinics, getAmbulancesByIds, getClinicsByIds } from "@/server/directory/repo";
import { ingestDirectory, parseDirectoryCsv } from "@/server/directory/ingest";
import { getCoverageSummary, resetCoverageCache } from "@/server/directory/coverage";
import { findDigitRuns } from "@/server/agent/scrub";

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
    expect((await loadActiveClinics()).map((c) => c.label).sort()).toEqual(["Arham Clinic Surat", "Mumbai - Ghatkopar Hospital"]);
    const clinicById = await getClinicsByIds([ids.clinicSurat]);
    expect(clinicById.get(ids.clinicSurat)).toMatchObject({ label: "Arham Clinic Surat", phone: "+912612345678", hours: "9am-7pm" });
  });

  it("resolves ids to active units and clinics only, so a handle issued before an ingest never renders a retired number", async () => {
    const ids = await seedDirectory();
    await getDb().update(ambulances).set({ active: false }).where(eq(ambulances.id, ids.ghatkopar));
    await getDb().update(clinics).set({ active: false }).where(eq(clinics.id, ids.clinicSurat));
    expect([...(await getAmbulancesByIds([ids.ghatkopar, ids.malad])).keys()]).toEqual([ids.malad]);
    expect((await getClinicsByIds([ids.clinicSurat])).size).toBe(0);
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

  it("keeps a phone-shaped run typed into a unit's areas covered out of the summary the prompt gets", async () => {
    const ids = await seedDirectory();
    await getDb().update(ambulances).set({ areasCovered: ["Bengaluru", "Call 98765 43210"] }).where(eq(ambulances.id, ids.bengaluru));
    const summary = await getCoverageSummary();
    expect(findDigitRuns(summary)).toEqual([]);
    expect(summary).toContain("- Bengaluru: whole city (1 unit) (also covers Call)");
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
    expect(second).toMatchObject({ ambulancesDeactivated: 0, clinicsDeactivated: 0 });
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

const HEADER = "Type,Name,City,Area,State,Phone,Area of Operation,Category,Operated By";
/** The header with the optional columns, which the lines of a file using it carry too. */
const HEADER_WITH_HOURS = `${HEADER},Hours,Address`;
/** The header with every optional column: a clinic's map link, page, services and notes after Address. */
const HEADER_WITH_LOCATIONS = `${HEADER_WITH_HOURS},Maps,Page,Services,Notes`;
const GHATKOPAR = 'Ambulance,Mumbai - Ghatkopar,Mumbai,Ghatkopar,Maharashtra,7000000001,"Ghatkopar, Vikhroli",Animal Ambulance,Arham Yuva Seva Group';
const MALAD = "Ambulance,Mumbai - Malad,Mumbai,Malad,Maharashtra,7000000002,Malad,Animal Ambulance,Arham Yuva Seva Group";
const SURAT_CLINIC = 'Clinic,Arham Clinic Surat,"Surat, Gujarat",Vesu,Gujarat,02612345678,,Clinic,Arham Yuva Seva Group';
const rowsOf = (...lines: string[]) => parseDirectoryCsv([HEADER, ...lines].join("\n"));

/** Everything an ingest can write, including updated_at, so a stray write shows up. */
async function snapshot() {
  const db = getDb();
  return {
    operators: await db.select({ name: operators.name, isArham: operators.isArham }).from(operators).orderBy(operators.name),
    ambulances: await db
      .select({ label: ambulances.label, phone: ambulances.phone, active: ambulances.active, updatedAt: ambulances.updatedAt })
      .from(ambulances)
      .orderBy(ambulances.label),
    clinics: await db.select({ label: clinics.label, phone: clinics.phone, active: clinics.active }).from(clinics).orderBy(clinics.label),
  };
}

describe("directory ingest safeguards", () => {
  beforeEach(async () => { await resetDb(); resetCoverageCache(); });

  it("deactivates what the CSV no longer lists and reactivates it when it returns", async () => {
    expect(await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC))).toMatchObject({
      ambulancesInserted: 2, ambulancesDeactivated: 0, clinicsInserted: 1, clinicsDeactivated: 0,
    });

    const beforeSecondRun = new Date();
    expect(await ingestDirectory(rowsOf(GHATKOPAR))).toMatchObject({ ambulancesUpdated: 1, ambulancesDeactivated: 1, clinicsDeactivated: 1 });
    expect((await loadActiveAmbulances()).map((r) => r.label)).toEqual(["Mumbai - Ghatkopar"]);
    expect(await loadActiveClinics()).toEqual([]);
    const [malad] = await getDb().select().from(ambulances).where(eq(ambulances.label, "Mumbai - Malad"));
    expect(malad.active).toBe(false);
    expect(malad.updatedAt.getTime()).toBeGreaterThanOrEqual(beforeSecondRun.getTime());
    // Rows that are already inactive are not counted again.
    expect(await ingestDirectory(rowsOf(GHATKOPAR))).toMatchObject({ ambulancesDeactivated: 0, clinicsDeactivated: 0 });

    expect(await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC))).toMatchObject({
      ambulancesInserted: 0, ambulancesUpdated: 2, ambulancesDeactivated: 0, clinicsInserted: 0, clinicsUpdated: 1,
    });
    expect((await loadActiveAmbulances()).map((r) => r.label).sort()).toEqual(["Mumbai - Ghatkopar", "Mumbai - Malad"]);
    expect((await loadActiveClinics()).map((c) => c.label)).toEqual(["Arham Clinic Surat"]);
  });

  it.each([
    ["an empty phone cell", MALAD.replace("7000000002", ""), 'Ambulance "Mumbai - Malad": Phone is empty'],
    ["a cell with two numbers", MALAD.replace("7000000002", "7000000002 / 7000000003"), 'Ambulance "Mumbai - Malad": Phone must be an Indian mobile number'],
    ["two rows with the same Name", MALAD.replace("Mumbai - Malad", "MUMBAI - GHATKOPAR"), 'Ambulance "MUMBAI - GHATKOPAR": Name is already used by Ambulance "Mumbai - Ghatkopar"'],
  ])("aborts on %s, naming the row, and writes nothing", async (_case, badLine, problem) => {
    await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC));
    const before = await snapshot();
    // Also changes a phone and drops the clinic, so a partial write would show.
    const error = await ingestDirectory(rowsOf(GHATKOPAR.replace("7000000001", "7000000009"), badLine)).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^CSV validation failed:\n/);
    expect((error as Error).message).toContain(problem);
    expect(await snapshot()).toEqual(before);
  });

  it("reads Arham's name in any case and spacing as Arham, keeping one Arham operator", async () => {
    const shouted = MALAD.replace("Arham Yuva Seva Group", "  ARHAM  yuva seva GROUP ");
    expect(await ingestDirectory(rowsOf(GHATKOPAR, shouted))).toMatchObject({ operators: 1, ambulancesInserted: 2 });
    expect((await loadActiveAmbulances()).map((r) => [r.label, r.operatorName, r.operatorIsArham])).toEqual([
      ["Mumbai - Ghatkopar", "Arham Yuva Seva Group", true],
      ["Mumbai - Malad", "Arham Yuva Seva Group", true],
    ]);
    expect((await snapshot()).operators).toEqual([{ name: "Arham Yuva Seva Group", isArham: true }]);
  });

  it("ingests a file whose text cells hold a phone-shaped number, and returns the warnings naming them", async () => {
    const summary = await ingestDirectory(rowsOf(GHATKOPAR.replace('"Ghatkopar, Vikhroli"', '"Ghatkopar, call 98765 43210"'), MALAD));
    expect(summary).toMatchObject({ ambulancesInserted: 2 });
    expect(summary.warnings).toEqual([
      'Ambulance "Mumbai - Ghatkopar": Area of Operation holds a phone-shaped number: put phone numbers only in the Phone column',
    ]);
    expect((await ingestDirectory(rowsOf(GHATKOPAR, MALAD))).warnings).toEqual([]);
  });

  it("names the units and clinics it deactivated", async () => {
    await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC));
    expect(await ingestDirectory(rowsOf(GHATKOPAR))).toMatchObject({
      ambulancesDeactivated: 1, clinicsDeactivated: 1,
      deactivatedLabels: { ambulances: ["Mumbai - Malad"], clinics: ["Arham Clinic Surat"] },
    });
    expect(await ingestDirectory(rowsOf(GHATKOPAR))).toMatchObject({ deactivatedLabels: { ambulances: [], clinics: [] } });
  });

  it("writes the Hours and Address cells, and clears them when a cell is emptied or the file drops the columns", async () => {
    const withHours = parseDirectoryCsv([
      HEADER_WITH_HOURS,
      `${GHATKOPAR},10am–7pm IST,`,
      `${MALAD},,`,
      `${SURAT_CLINIC},10am–11pm IST,"Vesu Main Road, near the temple"`,
    ].join("\n"));
    expect(await ingestDirectory(withHours)).toMatchObject({ ambulancesInserted: 2, clinicsInserted: 1, warnings: [] });
    expect((await loadActiveAmbulances()).map((r) => [r.label, r.hours]).sort()).toEqual([
      ["Mumbai - Ghatkopar", "10am–7pm IST"],
      ["Mumbai - Malad", null],
    ]);
    expect(await loadActiveClinics()).toMatchObject([{ label: "Arham Clinic Surat", hours: "10am–11pm IST", address: "Vesu Main Road, near the temple" }]);

    // The file is the directory: an older file without the columns clears what the last one wrote.
    expect(await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC))).toMatchObject({ ambulancesUpdated: 2, clinicsUpdated: 1 });
    expect((await loadActiveAmbulances()).map((r) => r.hours)).toEqual([null, null]);
    expect(await loadActiveClinics()).toMatchObject([{ hours: null, address: null }]);
  });

  it("writes a clinic's Maps, Page, Services and Notes cells, reads them back, and clears them when the file drops the columns", async () => {
    const maps = "https://maps.google.com/?q=21.17024,72.83106";
    const withLocations = parseDirectoryCsv([
      HEADER_WITH_LOCATIONS,
      // An ambulance row's link cells are not read: units have no map link.
      `${GHATKOPAR},10am–7pm IST,,"${maps}",https://alwayscare.org/ambulances,X-ray,Free`,
      `${SURAT_CLINIC},10am–11pm IST,"Vesu Main Road, near the temple","${maps}",https://alwayscare.org/clinics/surat,"OPD; X-ray",Treatment for injured street animals is free; pets: call first.`,
    ].join("\n"));
    expect(await ingestDirectory(withLocations)).toMatchObject({ ambulancesInserted: 1, clinicsInserted: 1, warnings: [] });
    const [surat] = await loadActiveClinics();
    expect(surat).toMatchObject({
      label: "Arham Clinic Surat", address: "Vesu Main Road, near the temple", mapsUrl: maps, pageUrl: "https://alwayscare.org/clinics/surat",
      services: "OPD; X-ray", notes: "Treatment for injured street animals is free; pets: call first.",
    });
    expect((await getClinicsByIds([surat.id])).get(surat.id)).toEqual(surat);

    // An empty cell clears its column, and so does an older file without the columns.
    expect(await ingestDirectory(parseDirectoryCsv([HEADER_WITH_LOCATIONS, `${GHATKOPAR},,,,,,`, `${SURAT_CLINIC},,,"${maps}",,,`].join("\n"))))
      .toMatchObject({ clinicsUpdated: 1 });
    expect(await loadActiveClinics()).toMatchObject([{ mapsUrl: maps, pageUrl: null, services: null, notes: null }]);
    expect(await ingestDirectory(rowsOf(GHATKOPAR, SURAT_CLINIC))).toMatchObject({ clinicsUpdated: 1 });
    expect(await loadActiveClinics()).toMatchObject([{ address: null, mapsUrl: null, pageUrl: null, services: null, notes: null }]);
  });

  it("refuses a clinic whose Maps cell is not a Google Maps link to coordinates, and writes nothing", async () => {
    await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC));
    const before = await snapshot();
    const bad = parseDirectoryCsv([HEADER_WITH_LOCATIONS, `${GHATKOPAR},,,,,,`, `${SURAT_CLINIC},,,call 98765 43210,,,`].join("\n"));
    await expect(ingestDirectory(bad)).rejects.toThrow('Clinic "Arham Clinic Surat": Maps must be a Google Maps link to coordinates');
    const waMe = parseDirectoryCsv([HEADER_WITH_LOCATIONS, `${GHATKOPAR},,,,,,`, `${SURAT_CLINIC},,,https://wa.me/919876543210,,,`].join("\n"));
    await expect(ingestDirectory(waMe)).rejects.toThrow('Clinic "Arham Clinic Surat": Maps must be a Google Maps link to coordinates');
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a CSV with no ambulance rows instead of deactivating the whole directory", async () => {
    await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC));
    const before = await snapshot();
    await expect(ingestDirectory(rowsOf(SURAT_CLINIC))).rejects.toThrow("no ambulance rows");
    await expect(ingestDirectory(parseDirectoryCsv(""))).rejects.toThrow("no ambulance rows");
    await expect(ingestDirectory(parseDirectoryCsv([HEADER.replace("Type", "Kind"), GHATKOPAR].join("\n")))).rejects.toThrow("no ambulance rows");
    expect(await snapshot()).toEqual(before);
  });

  it("rolls the whole ingest back when it fails before commit", async () => {
    await ingestDirectory(rowsOf(GHATKOPAR, MALAD, SURAT_CLINIC));
    const before = await snapshot();
    const db = getDb();
    // Throws after every statement of the ingest has run, so anything not written through
    // the transaction would survive the rollback and show up in the snapshot.
    const failsBeforeCommit = new Proxy(db, {
      get: (target, prop, receiver) =>
        prop === "transaction"
          ? (work: (tx: unknown) => Promise<unknown>) =>
              target.transaction(async (tx) => {
                await work(tx);
                throw new Error("simulated failure before commit");
              })
          : Reflect.get(target, prop, receiver),
    });
    // Changes a phone, adds an operator and a unit, and would deactivate Malad and the clinic.
    const changed = rowsOf(
      GHATKOPAR.replace("7000000001", "7000000009"),
      "Ambulance,Pune - Aundh,Pune,Aundh,Maharashtra,7000000008,Aundh,Animal Ambulance,New Partner Trust"
    );
    await expect(ingestDirectory(changed, failsBeforeCommit)).rejects.toThrow("simulated failure before commit");
    expect(await snapshot()).toEqual(before);
  });
});
