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

export { DEFAULT_MAX_RESULTS } from "./types.js";

export { inferSeniorityFromTitle } from "./seniority.js";
export { inferRoleKindsFromTitle } from "./role_kind.js";
export { htmlToText } from "./html.js";
