import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Profile } from "../../core/constants.js";
import type { CriticAdapter } from "../../workflow/product/critic/critic.js";
import { MINIMAL_TOOLS } from "../constants.js";
import { registerCaptureTools } from "./capture.js";
import { registerCriticTool } from "./critic.js";
import { registerDiagnoseTools } from "./diagnose.js";
import { registerEvidenceTools } from "./evidence.js";
import { registerGraphTools } from "./graph.js";
import { registerObservationTools } from "./observations.js";
import { registerReproductionTool } from "./reproduction.js";
import { registerScopeTools } from "./scope.js";
import { registerUserFeedbackTool } from "./user-feedback.js";
import { registerWorkflowTools } from "./workflow.js";

export function registerTools(
  server: McpServer,
  root: string,
  // Keep the low-level API complete unless its caller deliberately filters it.
  profile: Profile = "standard",
  criticHost?: CriticAdapter,
  userFeedbackHost?: import("../../workflow/product/user-feedback.js").UserFeedbackHost,
): void {
  const host = profile === "minimal" ? minimalHost(server) : server;

  registerWorkflowTools(host, root);
  registerCaptureTools(host, root);
  registerObservationTools(host, root);
  registerScopeTools(host, root);
  registerEvidenceTools(host, root);
  registerReproductionTool(host, root);
  registerCriticTool(host, root, server, criticHost);
  registerUserFeedbackTool(host, root, server, userFeedbackHost);
  registerGraphTools(host, root);
  registerDiagnoseTools(host, root);
}

/**
 * The server, except that every tool outside the minimal set is removed as soon as it is
 * registered, so the registration functions stay untouched. Review dispatch also needs the
 * real protocol server to inspect and invoke the client's sampling capability.
 */
function minimalHost(server: McpServer): McpServer {
  const minimal: ReadonlySet<string> = MINIMAL_TOOLS;
  const registerTool: McpServer["registerTool"] = (name, config, callback) => {
    const registered = server.registerTool(name, config, callback);
    if (!minimal.has(name)) registered.remove();
    return registered;
  };
  return new Proxy(server, {
    get: (target, key) => (key === "registerTool" ? registerTool : Reflect.get(target, key)),
  });
}
