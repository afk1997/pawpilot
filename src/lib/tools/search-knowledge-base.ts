import { tool } from "ai";
import { z } from "zod";
import { searchKnowledgeBase } from "../kb/repository";

export const searchKnowledgeBaseParams = z.object({
  query: z.string().min(1),
  categories: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});

export const searchKnowledgeBaseTool = tool({
  description:
    "Search the Supabase-backed AlwaysCare knowledge base. Use only for non-phone factual answers; do not invent facts beyond returned evidence.",
  inputSchema: searchKnowledgeBaseParams,
  execute: async (input) => searchKnowledgeBase(input),
});
