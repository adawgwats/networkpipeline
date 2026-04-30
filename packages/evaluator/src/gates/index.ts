export {
  GATE_ORDER,
  buildReasonCode,
  slugifyReasonValue,
  type GateName,
  type GatePassResult,
  type GateRejectResult,
  type GateResult
} from "./result.js";

export { hardGateCheck } from "./check.js";

export { type DiscoveredPostingMetadata } from "./metadata.js";

export {
  PRE_EXTRACTION_GATES,
  preExtractionGateCheck
} from "./pre_extraction.js";
