import { getServiceSupabase, loadLocalEnv } from "./common";

async function main(): Promise<void> {
  loadLocalEnv();
  const embeddingKey = process.env.OPENAI_API_KEY ?? process.env.EMBEDDING_API_KEY;
  if (!embeddingKey) {
    console.log("kb:embed skipped: no OPENAI_API_KEY or EMBEDDING_API_KEY configured.");
    return;
  }

  const supabase = getServiceSupabase();
  const { count, error } = await supabase
    .from("kb_article_chunks")
    .select("id", { count: "exact", head: true })
    .is("embedding_json", null);
  if (error) throw error;

  console.log(
    `kb:embed found ${count ?? 0} chunks without embeddings. Embedding generation is gated; wire provider-specific embedding calls here when credentials and model policy are approved.`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
