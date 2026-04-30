import { ashbyConnector } from "./connectors/ashby.js";
import { careerPageConnector } from "./connectors/career_page.js";
import { greenhouseConnector } from "./connectors/greenhouse.js";
import { indeedConnector } from "./connectors/indeed.js";
import { leverConnector } from "./connectors/lever.js";
import { manualPasteConnector } from "./connectors/manual_paste.js";
import { recruiterEmailConnector } from "./connectors/recruiter_email.js";
import type { AnyConnector, SourceId } from "./connector/types.js";

/**
 * Connector registry. Constructs every connector with default options
 * once and exposes lookup by SourceId. The discovery orchestrator and
 * the MCP tool layer both consume this — there's only one source of
 * truth for "which connectors exist".
 *
 * To customize options (e.g. fetchImpl for tests), instantiate the
 * specific connector directly rather than mutating this registry.
 */
const REGISTRY: Record<SourceId, AnyConnector> = {
  indeed: indeedConnector(),
  greenhouse: greenhouseConnector(),
  lever: leverConnector(),
  ashby: ashbyConnector(),
  career_page: careerPageConnector(),
  recruiter_email: recruiterEmailConnector(),
  manual_paste: manualPasteConnector()
};

/** Resolve a connector by its SourceId, or undefined when unknown. */
export function connectorById(id: SourceId): AnyConnector | undefined {
  return REGISTRY[id];
}

/** Snapshot of every registered connector. */
export function allConnectors(): AnyConnector[] {
  return Object.values(REGISTRY);
}
