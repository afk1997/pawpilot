import { tool } from "ai";
import { z } from "zod";
import { getFactsByCategory, getOfficialLinks } from "../kb/repository";

export const getDonationInfoTool = tool({
  description:
    "Fetch verified donation facts and official donation/refund links from Supabase. Use for donation, 80G, payment, refund, CSR, and impact questions.",
  inputSchema: z.object({}),
  execute: async () => ({
    facts: await getFactsByCategory("donation"),
    links: await getOfficialLinks({ keys: ["donate", "refund_cancellation", "email_support"] }),
  }),
});
