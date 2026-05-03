/**
 * Barrel of LLM-callable tools.
 *
 * `buildAgentTools(conversationId)` returns the toolset bound to the current
 * conversation — needed for tools that mutate state on the conversation
 * (escalate, eventually status changes from inside the loop).
 */
import { findAmbulanceByAreaTool } from "./find-ambulance-by-area";
import { getNearestAmbulanceTool } from "./get-nearest-ambulance";
import { getCaseByReporterTool } from "./get-case-by-reporter";
import { buildEscalateTool } from "./escalate-to-dispatcher";
import { searchKnowledgeBaseTool } from "./search-knowledge-base";
import { getOfficialLinkTool } from "./get-official-link";
import { getDonationInfoTool } from "./get-donation-info";
import { getVolunteerInfoTool } from "./get-volunteer-info";
import { getCoverageStatusTool } from "./get-coverage-status";
import { getResponseTemplateTool } from "./get-response-template";

export function buildAgentTools(conversationId: string) {
  return {
    find_ambulance_by_area: findAmbulanceByAreaTool,
    get_nearest_ambulance: getNearestAmbulanceTool,
    get_case_by_reporter: getCaseByReporterTool,
    escalate_to_dispatcher: buildEscalateTool(conversationId),
    search_knowledge_base: searchKnowledgeBaseTool,
    get_official_link: getOfficialLinkTool,
    get_donation_info: getDonationInfoTool,
    get_volunteer_info: getVolunteerInfoTool,
    get_coverage_status: getCoverageStatusTool,
    get_response_template: getResponseTemplateTool,
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
