import { tool } from "ai";
import { z } from "zod";
import { getCoverageStatus } from "../kb/repository";

export const getCoverageStatusParams = z.object({
  city: z.string().optional(),
  area: z.string().optional(),
});

export const getCoverageStatusTool = tool({
  description:
    "Fetch active or launching-soon coverage status from Supabase. Use before making any coverage claim.",
  inputSchema: getCoverageStatusParams,
  execute: async (input) => getCoverageStatus(input),
});
