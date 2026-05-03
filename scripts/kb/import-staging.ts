import { resolve } from "node:path";
import { parseWorkbook } from "../../src/lib/kb/parse-workbook";
import { validateParsedWorkbook } from "../../src/lib/kb/validate-workbook";
import {
  chunkArray,
  DEFAULT_WORKBOOK_PATH,
  getServiceSupabase,
  printValidationReport,
  stagedRecords,
  workbookSummary,
} from "./common";

async function main(): Promise<void> {
  const workbookPath = resolve(process.argv[2] ?? DEFAULT_WORKBOOK_PATH);
  const parsed = parseWorkbook(workbookPath);
  const report = validateParsedWorkbook(parsed);
  printValidationReport(report);
  if (report.errors.length > 0) {
    throw new Error("Workbook import blocked by validation errors.");
  }

  const supabase = getServiceSupabase();
  const source = await supabase
    .from("kb_sources")
    .upsert(
      {
        source_key: "alwayscare_workbook",
        name: "AlwaysCare WhatsApp AI Knowledge Base",
        source_type: "workbook",
        description: "Production workbook source for WhatsApp answer engine.",
      },
      { onConflict: "source_key" }
    )
    .select("id")
    .single();
  if (source.error || !source.data) throw source.error ?? new Error("Failed to upsert kb_sources.");

  const summary = workbookSummary(parsed);
  const version = await supabase
    .from("kb_source_versions")
    .upsert(
      {
        source_id: source.data.id,
        file_name: parsed.source.fileName,
        file_sha256: parsed.source.fileHash,
        validation_report: report,
        parsed_summary: summary,
      },
      { onConflict: "source_id,file_sha256" }
    )
    .select("id")
    .single();
  if (version.error || !version.data) {
    throw version.error ?? new Error("Failed to upsert kb_source_versions.");
  }

  const sourceVersionId = version.data.id as string;
  const deletion = await supabase.from("kb_staged_records").delete().eq("source_version_id", sourceVersionId);
  if (deletion.error) throw deletion.error;

  const records = stagedRecords(parsed).map((record) => ({
    ...record,
    source_version_id: sourceVersionId,
  }));
  for (const chunk of chunkArray(records)) {
    const insert = await supabase.from("kb_staged_records").insert(chunk);
    if (insert.error) throw insert.error;
  }

  console.log(`Imported source version ${sourceVersionId}`);
  console.log(`Staged ${records.length} records from ${parsed.source.fileName}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
