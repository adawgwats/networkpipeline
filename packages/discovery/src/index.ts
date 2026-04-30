export type {
  AnyConnector,
  DirectFetchResult,
  DirectFetchSourceConnector,
  FetchImpl,
  IngestInstruction,
  InstructionSourceConnector,
  NormalizedDiscoveredPosting,
  SourceConnector,
  SourceId,
  SourceQuery,
  WorkItem
} from "./connector/types.js";

export { inferSeniorityFromTitle } from "./connector/seniority.js";
export { htmlToText } from "./connector/html.js";
export { canonicalizeUrl } from "./dedup.js";

export { indeedConnector, type IndeedConnectorOptions } from "./connectors/indeed.js";
export {
  greenhouseConnector,
  type GreenhouseConnectorOptions
} from "./connectors/greenhouse.js";
export { leverConnector, type LeverConnectorOptions } from "./connectors/lever.js";
export { ashbyConnector, type AshbyConnectorOptions } from "./connectors/ashby.js";
export {
  careerPageConnector,
  type CareerPageConnectorOptions
} from "./connectors/career_page.js";
export {
  recruiterEmailConnector,
  DEFAULT_RECRUITER_QUERY,
  type RecruiterEmailConnectorOptions
} from "./connectors/recruiter_email.js";
export { manualPasteConnector } from "./connectors/manual_paste.js";

export { connectorById, allConnectors } from "./registry.js";

export {
  startDiscovery,
  recordDiscoveredPostings,
  evaluateAllSurvivors,
  finalizeSearchRun,
  type DiscoveryRepositories,
  type StartDiscoveryOptions,
  type StartDiscoveryResult,
  type RecordOptions,
  type RecordResult,
  type EvaluateAllOptions,
  type EvaluateAllResult,
  type FinalizeOptions
} from "./orchestrator.js";
