import { tool } from "ai";
import { z } from "zod";
import { getResponseTemplates } from "../kb/repository";

export const getResponseTemplateParams = z.object({
  intent: z.string().optional(),
  templateKey: z.string().optional(),
});

export const getResponseTemplateTool = tool({
  description:
    "Fetch a safe response template from Supabase. Unsafe dispatch-like workbook templates are excluded during publish.",
  inputSchema: getResponseTemplateParams,
  execute: async (input) => getResponseTemplates(input),
});
