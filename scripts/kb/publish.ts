import {
  chunkArray,
  getServiceSupabase,
  type JsonRecord,
} from "./common";
import type {
  AmbulanceDraft,
  ClinicDraft,
  CoverageAreaDraft,
  EscalationRuleDraft,
  KBArticleChunkDraft,
  KBArticleDraft,
  KBFactDraft,
  OfficialLinkDraft,
  ResponseTemplateDraft,
} from "../../src/lib/kb/types";

type StagedRecord = {
  record_type: string;
  natural_key: string;
  payload: JsonRecord;
};

type OperatorRow = { id: string; name: string; is_arham: boolean };

const ARHAM_NAME = "Arham Yuva Seva Group";

async function main(): Promise<void> {
  const supabase = getServiceSupabase();
  const sourceVersionId = process.argv[2] ?? (await latestSourceVersionId(supabase));
  if (!sourceVersionId) throw new Error("No kb_source_versions row found. Run npm run kb:import first.");

  const { data: staged, error: stagedError } = await supabase
    .from("kb_staged_records")
    .select("record_type,natural_key,payload")
    .eq("source_version_id", sourceVersionId);
  if (stagedError) throw stagedError;
  if (!staged || staged.length === 0) throw new Error(`No staged records found for ${sourceVersionId}.`);

  const batch = await supabase
    .from("kb_publish_batches")
    .insert({ source_version_id: sourceVersionId, status: "started" })
    .select("id")
    .single();
  if (batch.error || !batch.data) throw batch.error ?? new Error("Failed to create publish batch.");
  const batchId = batch.data.id as string;

  try {
    const records = staged as StagedRecord[];
    await publishOperatorsAndDirectory(supabase, sourceVersionId, records);
    await publishKbRecords(supabase, sourceVersionId, records);

    const summary = {
      articles: payloads<KBArticleDraft>(records, "article").length,
      chunks: payloads<KBArticleChunkDraft>(records, "chunk").length,
      facts: payloads<KBFactDraft>(records, "fact").length,
      officialLinks: payloads<OfficialLinkDraft>(records, "official_link").length,
      responseTemplates: payloads<ResponseTemplateDraft>(records, "response_template").length,
      escalationRules: payloads<EscalationRuleDraft>(records, "escalation_rule").length,
      coverageAreas: payloads<CoverageAreaDraft>(records, "coverage_area").length,
      ambulances: payloads<AmbulanceDraft>(records, "ambulance").length,
      clinics: payloads<ClinicDraft>(records, "clinic").length,
    };

    await supabase
      .from("kb_publish_batches")
      .update({ status: "published", summary, finished_at: new Date().toISOString() })
      .eq("id", batchId);
    await supabase
      .from("kb_source_versions")
      .update({ published_at: new Date().toISOString() })
      .eq("id", sourceVersionId);

    console.log(`Published source version ${sourceVersionId}`);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await supabase
      .from("kb_publish_batches")
      .update({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      })
      .eq("id", batchId);
    throw error;
  }
}

async function latestSourceVersionId(supabase: ReturnType<typeof getServiceSupabase>): Promise<string | null> {
  const { data, error } = await supabase
    .from("kb_source_versions")
    .select("id")
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function publishOperatorsAndDirectory(
  supabase: ReturnType<typeof getServiceSupabase>,
  sourceVersionId: string,
  records: StagedRecord[]
): Promise<void> {
  const ambulances = payloads<AmbulanceDraft>(records, "ambulance");
  const clinics = payloads<ClinicDraft>(records, "clinic");
  const operatorNames = [...new Set([...ambulances.map((row) => row.operatedBy), ...clinics.map((row) => row.operatedBy)])];

  for (const name of operatorNames) {
    const { error } = await supabase
      .from("ngo_operators")
      .upsert({ name, is_arham: name === ARHAM_NAME, active: true }, { onConflict: "name" });
    if (error) throw error;
  }

  const { data, error } = await supabase
    .from("ngo_operators")
    .select("id,name,is_arham")
    .in("name", operatorNames);
  if (error) throw error;
  const operators = new Map((data as OperatorRow[] | null ?? []).map((row) => [row.name, row.id]));

  for (const row of ambulances) {
    const operatorId = operators.get(row.operatedBy);
    if (!operatorId) throw new Error(`Missing operator after upsert: ${row.operatedBy}`);
    await upsertAmbulanceRow(supabase, {
      operator_id: operatorId,
      label: row.label,
      city: row.city,
      area: row.area ?? null,
      state: row.state,
      phone: row.phone,
      phone_raw: row.phoneRaw,
      areas_covered: row.areasCovered,
      category: row.category,
      active: true,
      updated_at: new Date().toISOString(),
    });
  }
  await deactivateStaleAmbulances(supabase, ambulances, operators);

  for (const row of clinics) {
    const operatorId = operators.get(row.operatedBy);
    if (!operatorId) throw new Error(`Missing operator after upsert: ${row.operatedBy}`);
    await upsertClinicRow(supabase, {
      operator_id: operatorId,
      label: row.label,
      city: row.city,
      area: row.area ?? null,
      state: row.state,
      phone: row.phone,
      phone_raw: row.phoneRaw,
      hours: row.timings ?? null,
      active: true,
    });
  }
  await deactivateStaleClinics(supabase, clinics, operators);

  console.log(`Directory publish complete for source version ${sourceVersionId}`);
}

async function deactivateStaleAmbulances(
  supabase: ReturnType<typeof getServiceSupabase>,
  workbookRows: AmbulanceDraft[],
  operators: Map<string, string>
): Promise<void> {
  const desired = new Set(
    workbookRows.map((row) =>
      [row.label, row.phone, row.category, operators.get(row.operatedBy)].join("|")
    )
  );
  const { data, error } = await supabase
    .from("ambulances")
    .select("id,label,phone,category,operator_id")
    .eq("active", true);
  if (error) throw error;
  const staleIds = ((data as Array<{
    id: string;
    label: string;
    phone: string;
    category: string;
    operator_id: string;
  }> | null) ?? [])
    .filter((row) => !desired.has([row.label, row.phone, row.category, row.operator_id].join("|")))
    .map((row) => row.id);
  for (const chunk of chunkArray(staleIds, 100)) {
    const { error: updateError } = await supabase
      .from("ambulances")
      .update({ active: false, updated_at: new Date().toISOString() })
      .in("id", chunk);
    if (updateError) throw updateError;
  }
}

async function deactivateStaleClinics(
  supabase: ReturnType<typeof getServiceSupabase>,
  workbookRows: ClinicDraft[],
  operators: Map<string, string>
): Promise<void> {
  const desired = new Set(
    workbookRows.map((row) => [row.label, row.phone, operators.get(row.operatedBy)].join("|"))
  );
  const { data, error } = await supabase
    .from("clinics")
    .select("id,label,phone,operator_id")
    .eq("active", true);
  if (error) throw error;
  const staleIds = ((data as Array<{
    id: string;
    label: string;
    phone: string;
    operator_id: string;
  }> | null) ?? [])
    .filter((row) => !desired.has([row.label, row.phone, row.operator_id].join("|")))
    .map((row) => row.id);
  for (const chunk of chunkArray(staleIds, 100)) {
    const { error: updateError } = await supabase.from("clinics").update({ active: false }).in("id", chunk);
    if (updateError) throw updateError;
  }
}

async function publishKbRecords(
  supabase: ReturnType<typeof getServiceSupabase>,
  sourceVersionId: string,
  records: StagedRecord[]
): Promise<void> {
  for (const table of ["kb_articles", "kb_facts", "official_links", "coverage_areas", "response_templates", "escalation_rules"]) {
    const { error } = await supabase.from(table).update({ active: false }).eq("active", true);
    if (error) throw error;
  }

  const articleIdByKey = new Map<string, string>();
  for (const row of payloads<KBArticleDraft>(records, "article")) {
    const { data, error } = await supabase
      .from("kb_articles")
      .upsert(
        {
          source_version_id: sourceVersionId,
          article_key: row.articleKey,
          category: row.category,
          title: row.title,
          body: row.body,
          language: row.language,
          active: true,
          source_sheet: row.sourceSheet,
          source_row: row.sourceRow,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "article_key" }
      )
      .select("id,article_key")
      .single();
    if (error || !data) throw error ?? new Error(`Failed to publish article ${row.articleKey}`);
    articleIdByKey.set(row.articleKey, data.id as string);
  }

  for (const articleId of articleIdByKey.values()) {
    const { error } = await supabase.from("kb_article_chunks").delete().eq("article_id", articleId);
    if (error) throw error;
  }

  const chunkRows = payloads<KBArticleChunkDraft>(records, "chunk").flatMap((row) => {
    const articleId = articleIdByKey.get(row.articleKey);
    if (!articleId) return [];
    return [
      {
        source_version_id: sourceVersionId,
        article_id: articleId,
        article_key: row.articleKey,
        chunk_index: row.chunkIndex,
        content: row.content,
        source_sheet: row.sourceSheet,
        source_row: row.sourceRow,
      },
    ];
  });
  for (const chunk of chunkArray(chunkRows)) {
    const { error } = await supabase.from("kb_article_chunks").insert(chunk);
    if (error) throw error;
  }

  await upsertRows(
    supabase,
    "kb_facts",
    payloads<KBFactDraft>(records, "fact").map((row) => ({
      source_version_id: sourceVersionId,
      fact_key: row.factKey,
      category: row.category,
      label: row.label,
      value: row.value,
      value_type: row.valueType,
      language: "en",
      active: true,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      updated_at: new Date().toISOString(),
    })),
    "fact_key"
  );

  await upsertRows(
    supabase,
    "official_links",
    payloads<OfficialLinkDraft>(records, "official_link").map((row) => ({
      source_version_id: sourceVersionId,
      link_key: row.linkKey,
      label: row.label,
      url: row.url,
      notes: row.notes ?? null,
      active: true,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      updated_at: new Date().toISOString(),
    })),
    "link_key"
  );

  await upsertRows(
    supabase,
    "coverage_areas",
    payloads<CoverageAreaDraft>(records, "coverage_area").map((row) => ({
      source_version_id: sourceVersionId,
      coverage_key: row.coverageKey,
      city: row.city,
      area: row.area ?? null,
      state: row.state,
      status: row.status,
      aliases: row.aliases,
      notes: row.notes ?? null,
      active: true,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      updated_at: new Date().toISOString(),
    })),
    "coverage_key"
  );

  await upsertRows(
    supabase,
    "response_templates",
    payloads<ResponseTemplateDraft>(records, "response_template").map((row) => ({
      source_version_id: sourceVersionId,
      template_key: row.templateKey,
      scenario: row.scenario,
      intent: row.intent,
      language: row.language,
      template: row.template,
      safe: true,
      active: true,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      updated_at: new Date().toISOString(),
    })),
    "template_key"
  );

  await upsertRows(
    supabase,
    "escalation_rules",
    payloads<EscalationRuleDraft>(records, "escalation_rule").map((row) => ({
      source_version_id: sourceVersionId,
      rule_key: row.ruleKey,
      trigger: row.trigger,
      action: row.action,
      route_to: row.routeTo,
      active: true,
      source_sheet: row.sourceSheet,
      source_row: row.sourceRow,
      updated_at: new Date().toISOString(),
    })),
    "rule_key"
  );
}

async function upsertAmbulanceRow(
  supabase: ReturnType<typeof getServiceSupabase>,
  payload: JsonRecord
): Promise<void> {
  const existing = await supabase
    .from("ambulances")
    .select("id")
    .eq("label", payload.label)
    .eq("phone", payload.phone)
    .eq("category", payload.category)
    .eq("operator_id", payload.operator_id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) {
    const { error } = await supabase.from("ambulances").update(payload).eq("id", existing.data.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("ambulances").insert(payload);
  if (error) throw error;
}

async function upsertClinicRow(
  supabase: ReturnType<typeof getServiceSupabase>,
  payload: JsonRecord
): Promise<void> {
  const existing = await supabase
    .from("clinics")
    .select("id")
    .eq("label", payload.label)
    .eq("phone", payload.phone)
    .eq("operator_id", payload.operator_id)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) {
    const { error } = await supabase.from("clinics").update(payload).eq("id", existing.data.id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("clinics").insert(payload);
  if (error) throw error;
}

async function upsertRows(
  supabase: ReturnType<typeof getServiceSupabase>,
  table: string,
  rows: JsonRecord[],
  onConflict: string
): Promise<void> {
  for (const chunk of chunkArray(rows)) {
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) throw error;
  }
}

function payloads<T>(records: StagedRecord[], type: string): T[] {
  return records.filter((record) => record.record_type === type).map((record) => record.payload as T);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
