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
