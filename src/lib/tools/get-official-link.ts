import { tool } from "ai";
import { z } from "zod";
import { getOfficialLinks } from "../kb/repository";

export const getOfficialLinkParams = z.object({
  linkKey: z
    .enum([
      "website",
      "donate",
      "find_ambulance",
      "find_clinic",
      "live_impact",
      "volunteer",
      "instagram",
      "whatsapp_channel",
      "privacy_policy",
      "terms_conditions",
      "refund_cancellation",
      "email_support",
    ])
    .optional(),
});

export const getOfficialLinkTool = tool({
  description:
    "Fetch official AlwaysCare links from Supabase. URLs must come from this tool before appearing in an answer.",
  inputSchema: getOfficialLinkParams,
  execute: async (input) => getOfficialLinks(input),
});
