export {
  EXTRACTOR_VERSION,
  extractedJobFactsSchema,
  industryTagSchema,
  requiredOnsiteSchema,
  requiredYoeSchema,
  type ExtractedJobFacts,
  type IndustryTag,
  type RequiredOnsite,
  type RequiredYoe
} from "./schema.js";

export { EXTRACT_PROMPT_ID, EXTRACT_SYSTEM_PROMPT } from "./prompt.js";

export {
  buildExtractUserPrompt,
  extractJobFacts,
  hashPostingText,
  type ExtractJobFactsInput,
  type ExtractJobFactsResult
} from "./extract.js";
