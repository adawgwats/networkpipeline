export {
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
  parseCriteriaFromYaml,
  resolveCriteriaPath
} from "./load.js";
