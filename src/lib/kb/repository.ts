import { supabase } from "../supabase";
import type { AnswerIntent, EvidenceArticle, EvidenceFact, EvidenceLink, EvidenceTemplate } from "../answer-engine/types";

export interface KnowledgeSearchResult {
  articles: EvidenceArticle[];
  facts: EvidenceFact[];
}

export interface CoverageStatusResult {
  city: string;
  area: string | null;
  state: string;
  status: "active" | "launching_soon" | "unknown";
  aliases: string[];
  notes: string | null;
}

type FactRow = {
  fact_key: string;
  category: string;
  label: string;
  value: string;
};

type ArticleRow = {
  article_key: string;
  category: string;
  title: string;
  body: string;
};

type LinkRow = {
  link_key: string;
  label: string;
  url: string;
  notes: string | null;
};

type TemplateRow = {
  template_key: string;
  scenario: string;
  intent: string | null;
  template: string;
};

type CoverageRow = {
  city: string;
  area: string | null;
  state: string;
  status: "active" | "launching_soon" | "unknown";
  aliases: string[] | null;
  notes: string | null;
};

export async function searchKnowledgeBase(input: {
  query: string;
  categories?: string[];
  limit?: number;
}): Promise<KnowledgeSearchResult> {
  const query = input.query.trim();
  const limit = input.limit ?? 5;
  if (!query) return { articles: [], facts: [] };
  const like = `%${escapeLike(query)}%`;

  let articleQuery = supabase
    .from("kb_articles")
    .select("article_key,category,title,body")
    .eq("active", true)
    .or(`title.ilike.${like},body.ilike.${like}`)
    .limit(limit);
  let factQuery = supabase
    .from("kb_facts")
    .select("fact_key,category,label,value")
    .eq("active", true)
    .or(`label.ilike.${like},value.ilike.${like}`)
    .limit(limit);

  if (input.categories?.length) {
    articleQuery = articleQuery.in("category", input.categories);
    factQuery = factQuery.in("category", input.categories);
  }

  const [articles, facts] = await Promise.all([articleQuery, factQuery]);
  if (articles.error) console.warn("searchKnowledgeBase article error:", articles.error.message);
  if (facts.error) console.warn("searchKnowledgeBase fact error:", facts.error.message);

  return {
    articles: ((articles.data as ArticleRow[] | null) ?? []).map((row) => ({
      key: row.article_key,
      category: row.category,
      title: row.title,
      body: row.body,
    })),
    facts: ((facts.data as FactRow[] | null) ?? []).map((row) => ({
      key: row.fact_key,
      category: row.category,
      label: row.label,
      value: row.value,
    })),
  };
}

export async function getOfficialLinks(input: {
  linkKey?: string;
  keys?: string[];
} = {}): Promise<EvidenceLink[]> {
  let query = supabase
    .from("official_links")
    .select("link_key,label,url,notes")
    .eq("active", true);
  if (input.linkKey) query = query.eq("link_key", input.linkKey);
  if (input.keys?.length) query = query.in("link_key", input.keys);
  const { data, error } = await query;
  if (error) {
    console.warn("getOfficialLinks error:", error.message);
    return [];
  }
  return ((data as LinkRow[] | null) ?? []).map((row) => ({
    key: row.link_key,
    label: row.label,
    url: row.url,
    notes: row.notes,
  }));
}

export async function getFactsByCategory(category: string): Promise<EvidenceFact[]> {
  const { data, error } = await supabase
    .from("kb_facts")
    .select("fact_key,category,label,value")
    .eq("active", true)
    .eq("category", category)
    .order("fact_key", { ascending: true });
  if (error) {
    console.warn("getFactsByCategory error:", error.message);
    return [];
  }
  return ((data as FactRow[] | null) ?? []).map((row) => ({
    key: row.fact_key,
    category: row.category,
    label: row.label,
    value: row.value,
  }));
}

export async function getCoverageStatus(input: {
  city?: string;
  area?: string;
}): Promise<CoverageStatusResult[]> {
  if (!input.city && !input.area) return [];
  let query = supabase
    .from("coverage_areas")
    .select("city,area,state,status,aliases,notes")
    .eq("active", true)
    .limit(10);
  if (input.city) query = query.ilike("city", input.city);
  const { data, error } = await query;
  if (error) {
    console.warn("getCoverageStatus error:", error.message);
    return [];
  }
  const rows = ((data as CoverageRow[] | null) ?? []).filter((row) => {
    if (!input.area) return true;
    const wanted = input.area.toLowerCase();
    return (
      row.area?.toLowerCase() === wanted ||
      (row.aliases ?? []).some((alias) => alias.toLowerCase() === wanted)
    );
  });
  return rows.map((row) => ({
    city: row.city,
    area: row.area,
    state: row.state,
    status: row.status,
    aliases: row.aliases ?? [],
    notes: row.notes,
  }));
}

export async function getResponseTemplates(input: {
  intent?: AnswerIntent | string;
  templateKey?: string;
}): Promise<EvidenceTemplate[]> {
  let query = supabase
    .from("response_templates")
    .select("template_key,scenario,intent,template")
    .eq("active", true)
    .eq("safe", true)
    .limit(10);
  if (input.intent) query = query.eq("intent", input.intent);
  if (input.templateKey) query = query.eq("template_key", input.templateKey);
  const { data, error } = await query;
  if (error) {
    console.warn("getResponseTemplates error:", error.message);
    return [];
  }
  return ((data as TemplateRow[] | null) ?? []).map((row) => ({
    key: row.template_key,
    scenario: row.scenario,
    intent: row.intent,
    template: row.template,
  }));
}

function escapeLike(value: string): string {
  return value.replace(/[%_]/g, (char) => `\\${char}`);
}
