/**
 * Tool: get_static_content
 *
 * Fetches a snippet from the static content file for non-emergency intents:
 * donations, volunteer signup, FAQ, or human-emergency referral.
 *
 * Clinic info is special — it comes from the `clinics` DB table, not the
 * static file. We expose it via the same tool for consistency.
 */
import { z } from "zod";
import { tool } from "ai";
import { getStaticContent, type StaticTopic, type Language } from "../content";
import { supabase } from "../supabase";

export const getStaticContentParams = z.object({
  topic: z
    .enum(["donate", "volunteer", "about", "faq", "human_emergency_referral", "clinics"])
    .describe(
      "Which content section to fetch. 'clinics' returns the live clinic list from DB."
    ),
  language: z
    .enum(["en", "hi", "mr", "gu"])
    .optional()
    .describe("Reporter's language; falls back to English if not yet filled in."),
});

export type GetStaticContentInput = z.infer<typeof getStaticContentParams>;

export async function getStaticContentImpl(input: GetStaticContentInput): Promise<unknown> {
  const language: Language = input.language ?? "en";

  if (input.topic === "clinics") {
    const { data, error } = await supabase
      .from("clinics")
      .select("label, city, area, state, phone, address, hours")
      .eq("active", true);
    if (error) return [];
    return data;
  }

  return getStaticContent(input.topic as StaticTopic, language);
}

export const getStaticContentTool = tool({
  description:
    "Fetch static content for non-emergency intents (donations, volunteering, FAQ, human-emergency referral, clinic list). Use when the reporter is not reporting an animal emergency.",
  inputSchema: getStaticContentParams,
  execute: async (input) => getStaticContentImpl(input),
});
