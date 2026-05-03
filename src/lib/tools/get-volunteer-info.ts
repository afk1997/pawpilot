import { tool } from "ai";
import { z } from "zod";
import { getFactsByCategory, getOfficialLinks } from "../kb/repository";

export const getVolunteerInfoTool = tool({
  description:
    "Fetch verified volunteer facts and official volunteer link from Supabase.",
  inputSchema: z.object({}),
  execute: async () => ({
    facts: await getFactsByCategory("volunteer"),
    links: await getOfficialLinks({ keys: ["volunteer", "email_support"] }),
  }),
});
