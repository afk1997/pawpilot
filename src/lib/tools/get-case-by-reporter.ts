/**
 * Tool: get_case_by_reporter
 *
 * Looks up a recent case from Arham's Cases API by reporter phone number.
 * Used when the reporter asks "what happened to the dog I reported last week?"
 *
 * Returns null if no case is found OR the API is unavailable. Partner-NGO
 * cases are NOT in this API — by design. The agent should respond with what
 * it can, never inventing details.
 */
import { z } from "zod";
import { tool } from "ai";
import { getCaseByReporter as fetchCase, type ArhamCase } from "../clients/cases-api";

export const getCaseByReporterParams = z.object({
  phone: z
    .string()
    .describe("Reporter's phone in E.164 form (+91XXXXXXXXXX)."),
  days_back: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("How many days back to search (default 14, max 90)."),
});

export type GetCaseByReporterInput = z.infer<typeof getCaseByReporterParams>;

export type GetCaseByReporterResult = ArhamCase | { found: false };

export async function getCaseByReporter(
  input: GetCaseByReporterInput
): Promise<GetCaseByReporterResult> {
  const result = await fetchCase(input.phone, input.days_back ?? 14);
  if (!result) return { found: false };
  return result;
}

export const getCaseByReporterTool = tool({
  description:
    "Look up a recent case logged by Arham for a reporter's phone. Use when the reporter asks about a previous report. Returns the case record or { found: false }. Partner NGOs do NOT log cases here, so most cases will not be findable — that is expected and not an error.",
  inputSchema: getCaseByReporterParams,
  execute: async (input) => getCaseByReporter(input),
});
