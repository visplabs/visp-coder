/**
 * Names that form the MCP contract. A client hard-codes these strings, so they
 * change only with the protocol surface itself.
 */

import { PRODUCT_NAME } from "../core/constants.js";
import { VERSION } from "../core/version.js";

export const MCP_SERVER_NAME = PRODUCT_NAME;

/** The build-time version, so the MCP handshake can never disagree with --version. */
export const MCP_SERVER_VERSION = VERSION;

export const TOOL = {
  next: "visp_next",
  status: "visp_status",
  feature: "visp_feature",
  brief: "visp_brief",
  work: "visp_work",
  capture: "visp_capture",
  observations: "visp_observations",
  guard: "visp_guard",
  verify: "visp_verify",
  review: "visp_review",
  reproduce: "visp_reproduce",
  critic: "visp_critic",
  userFeedback: "visp_user_feedback",
  done: "visp_done",
  accept: "visp_accept",
  query: "visp_query",
  index: "visp_index",
  doctor: "visp_doctor",
} as const;

export type ToolName = (typeof TOOL)[keyof typeof TOOL];

/** Small but complete product loop, including image delivery and review. */
export const MINIMAL_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  TOOL.doctor,
  TOOL.next,
  TOOL.feature,
  TOOL.brief,
  TOOL.work,
  TOOL.done,
  TOOL.accept,
  TOOL.review,
  TOOL.reproduce,
  TOOL.critic,
  TOOL.userFeedback,
  TOOL.observations,
  TOOL.capture,
  TOOL.query,
  TOOL.guard,
]);

export const RESOURCE_MIME_TYPE = "application/json";

export const RESOURCE = {
  status: "visp://status",
  policy: "visp://policy",
  scope: "visp://scope",
  brief: "visp://feature/{id}/brief",
} as const;
