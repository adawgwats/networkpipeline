export {
  ALL_ROLE_KINDS,
  CURRENT_SCHEMA_VERSION,
  acceptedCalibrationExampleSchema,
  calibrationSchema,
  candidateCriteriaSchema,
  clearanceLevelSchema,
  employmentTypeSchema,
  hardGatesSchema,
  mustHaveConditionSchema,
  mustNotHaveConditionSchema,
  profileSchema,
  rejectedCalibrationExampleSchema,
  roleKindSchema,
  seniorityBandSchema,
  softPreferenceItemSchema,
  softPreferencesSchema,
  valuesRefusalsSchema,
  workAuthorizationSchema
} from "./schema.js";

export type {
  AcceptedCalibrationExample,
  Calibration,
  CandidateCriteria,
  ClearanceLevel,
  EmploymentType,
  HardGates,
  MustHaveCondition,
  MustNotHaveCondition,
  Profile,
  RejectedCalibrationExample,
  RoleKind,
  SeniorityBand,
  SoftPreferenceItem,
  SoftPreferences,
  ValuesRefusals,
  WorkAuthorization
} from "./schema.js";

export {
  CriteriaFileNotFoundError,
  CriteriaSchemaVersionError,
  CriteriaValidationError,
  CriteriaYamlParseError
} from "./errors.js";

export {
  tryValidateCriteria,
  validateCriteria
} from "./validate.js";

export {
  loadCriteriaFromFile,
  loadResolvedCriteriaFromFile,
  parseCriteriaFromYaml,
  resolveCriteriaPath
} from "./load.js";

export {
  applyOverlay,
  CriteriaCycleError,
  CriteriaDepthExceededError,
  MAX_EXTENDS_DEPTH,
  mergeCriteriaShallow,
  resolveAndApplyOverlays,
  resolveAndMergeExtends
} from "./merge.js";

export {
  overlayFragmentSchema,
  type OverlayFragment
} from "./overlay-schema.js";

export {
  resolveReferencePath,
  type ReferenceKind
} from "./resolve.js";

export { serializeCriteriaToYaml } from "./serialize.js";

export {
  bumpVersion,
  type BumpVersionOptions,
  type UpdatedVia
} from "./version.js";

export {
  writeCriteriaToFile,
  type WriteCriteriaOptions
} from "./write.js";
