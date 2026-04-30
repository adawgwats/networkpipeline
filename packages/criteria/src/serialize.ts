import { stringify as stringifyYaml } from "yaml";
import { validateCriteria } from "./validate.js";
import type { CandidateCriteria } from "./schema.js";

/**
 * Serialize a CandidateCriteria back to a YAML string.
 *
 * The output is always re-validated against the schema before being
 * stringified — guarantees that we never write invalid YAML to disk
 * and that round-trip parse → mutate → write → parse is stable.
 *
 * The `yaml` library's default options produce reasonable output for
 * human review and diffs:
 *   - block-style sequences (one entry per line, easy to git-diff)
 *   - explicit double-quoted strings only when needed (sparing for
 *     readability)
 *   - keys preserved in the order they appear on the input object
 *
 * Bytewise stability is NOT guaranteed across roundtrips because the
 * yaml library may normalize whitespace or quoting. Callers that need
 * an exact-byte snapshot should preserve the original yamlText
 * separately (which is why loadCriteriaFromFile returns it).
 */
export function serializeCriteriaToYaml(criteria: CandidateCriteria): string {
  // Defensive: a caller that mutated the object into invalid state
  // gets a precise validation error here rather than a malformed file
  // landing on disk.
  const validated = validateCriteria(criteria);

  return stringifyYaml(validated, {
    indent: 2,
    lineWidth: 100,
    minContentWidth: 40,
    // Keep field order from the input object so diffs stay tight.
    sortMapEntries: false,
    // Use block-style for arrays so PRs are reviewable.
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN"
  });
}
