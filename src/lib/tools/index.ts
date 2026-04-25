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
import { getStaticContentTool } from "./get-static-content";

export function buildAgentTools(conversationId: string) {
  return {
    find_ambulance_by_area: findAmbulanceByAreaTool,
    get_nearest_ambulance: getNearestAmbulanceTool,
    get_case_by_reporter: getCaseByReporterTool,
    escalate_to_dispatcher: buildEscalateTool(conversationId),
    get_static_content: getStaticContentTool,
  };
}

export type AgentTools = ReturnType<typeof buildAgentTools>;
