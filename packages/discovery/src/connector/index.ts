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
} from "./types.js";

export { inferSeniorityFromTitle } from "./seniority.js";
export { htmlToText } from "./html.js";
