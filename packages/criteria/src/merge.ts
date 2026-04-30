import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  CriteriaFileNotFoundError,
  CriteriaValidationError,
  CriteriaYamlParseError
} from "./errors.js";
import {
  overlayFragmentSchema,
  type OverlayFragment
} from "./overlay-schema.js";
import { candidateCriteriaSchema, type CandidateCriteria } from "./schema.js";
import { resolveReferencePath, type ReferenceKind } from "./resolve.js";

/**
 * Maximum nesting depth for `extends`. A criteria file can extend a
 * template, which can extend another template, but no more than this.
 *
 * Three is enough to support real-world taxonomy ("ml-engineer-mid"
 * extends "ml-engineer" extends "engineer-base") without inviting
 * pathological chains.
 */
export const MAX_EXTENDS_DEPTH = 3;

export class CriteriaCycleError extends Error {
  readonly chain: string[];
  constructor(chain: string[]) {
    super(`Criteria reference cycle detected: ${chain.join(" -> ")}`);
    this.name = "CriteriaCycleError";
    this.chain = chain;
  }
}

export class CriteriaDepthExceededError extends Error {
  readonly depth: number;
  constructor(depth: number) {
    super(
      `extends chain exceeds maximum depth ${MAX_EXTENDS_DEPTH} (got ${depth}).`
    );
    this.name = "CriteriaDepthExceededError";
    this.depth = depth;
  }
}

/**
 * Resolve and merge the `extends` chain on top of the local criteria.
 *
 * Order of precedence:
 *   1. The deepest extended template provides defaults.
 *   2. Each level above overrides those defaults.
 *   3. The local file (the one explicitly written by the user) wins
 *      over everything.
 *
 * `extends` and `overlays` arrays from extended templates are NOT
 * recursively followed past the local file — the local file's
 * `extends` field is the only one that drives the chain.
 *
 * Cycles are rejected. Depth beyond MAX_EXTENDS_DEPTH is rejected.
 */
export async function resolveAndMergeExtends(
  local: CandidateCriteria,
  localPath: string
): Promise<CandidateCriteria> {
  if (local.extends.length === 0) return local;

  const visited = new Set<string>([localPath]);
  const chain: string[] = [localPath];
  const ancestors = await loadExtendsChain(
    local.extends,
    localPath,
    visited,
    chain,
    1
  );

  // Merge ancestors first (deepest → shallowest), then layer the local
  // file on top. Local always wins on conflicts.
  let merged = ancestors[0];
  for (let i = 1; i < ancestors.length; i++) {
    merged = mergeCriteriaShallow(merged, ancestors[i]);
  }
  return mergeCriteriaShallow(merged, local);
}

async function loadExtendsChain(
  references: string[],
  referrerPath: string,
  visited: Set<string>,
  chain: string[],
  depth: number
): Promise<CandidateCriteria[]> {
  if (depth > MAX_EXTENDS_DEPTH) {
    throw new CriteriaDepthExceededError(depth);
  }

  const out: CandidateCriteria[] = [];
  for (const ref of references) {
    const path = resolveReferencePath(ref, "extends", referrerPath);
    if (visited.has(path)) {
      throw new CriteriaCycleError([...chain, path]);
    }
    if (!existsSync(path)) throw new CriteriaFileNotFoundError(path);

    const raw = await readYaml(path);
    const parent = candidateCriteriaSchema.safeParse(raw);
    if (!parent.success) {
      throw new CriteriaValidationError(
        `Extended criteria at ${path} failed validation`,
        parent.error.issues
      );
    }

    const newVisited = new Set(visited);
    newVisited.add(path);
    const subChain = [...chain, path];

    if (parent.data.extends.length > 0) {
      const grandparents = await loadExtendsChain(
        parent.data.extends,
        path,
        newVisited,
        subChain,
        depth + 1
      );
      out.push(...grandparents);
    }
    out.push(parent.data);
  }
  return out;
}

/**
 * Apply each overlay file (in order) on top of the criteria. Overlays
 * are append-only by construction — see overlay-schema.ts.
 */
export async function resolveAndApplyOverlays(
  base: CandidateCriteria,
  basePath: string
): Promise<CandidateCriteria> {
  if (base.overlays.length === 0) return base;

  let result = base;
  for (const ref of base.overlays) {
    const path = resolveReferencePath(ref, "overlay", basePath);
    if (!existsSync(path)) throw new CriteriaFileNotFoundError(path);

    const raw = await readYaml(path);
    const parsed = overlayFragmentSchema.safeParse(raw);
    if (!parsed.success) {
      // Strict-mode failures here mean the overlay tried to set fields
      // outside the add-allowed sections. That's the cannot-weaken
      // rule firing at parse time.
      throw new CriteriaValidationError(
        `Overlay at ${path} violates the cannot-weaken rule (overlays may only contain hard_gates.must_not_have, values_refusals, and soft_preferences.negative).`,
        parsed.error.issues
      );
    }
    result = applyOverlay(result, parsed.data);
  }
  return result;
}

/**
 * Pure function: apply an OverlayFragment on top of a CandidateCriteria.
 * Append-only, never replaces. The strict overlay schema makes it
 * impossible for the overlay to express a weakening, so this function
 * does not need to validate "is the overlay safe?" — the schema
 * already did.
 */
export function applyOverlay(
  base: CandidateCriteria,
  overlay: OverlayFragment
): CandidateCriteria {
  return {
    ...base,
    hard_gates: {
      ...base.hard_gates,
      must_not_have: [
        ...base.hard_gates.must_not_have,
        ...(overlay.hard_gates?.must_not_have ?? [])
      ]
    },
    values_refusals: [
      ...base.values_refusals,
      ...(overlay.values_refusals ?? [])
    ],
    soft_preferences: {
      ...base.soft_preferences,
      negative: [
        ...base.soft_preferences.negative,
        ...(overlay.soft_preferences?.negative ?? [])
      ]
    }
  };
}

/**
 * Shallow merge: parent provides defaults, child wins. Used for the
 * extends chain. Does NOT touch `extends`/`overlays` lists — those are
 * driven by the local-most file only.
 */
export function mergeCriteriaShallow(
  parent: CandidateCriteria,
  child: CandidateCriteria
): CandidateCriteria {
  return {
    ...parent,
    ...child,
    profile: { ...parent.profile, ...child.profile },
    hard_gates: { ...parent.hard_gates, ...child.hard_gates },
    soft_preferences: {
      ...parent.soft_preferences,
      ...child.soft_preferences
    },
    calibration: { ...parent.calibration, ...child.calibration },
    // The child's extends/overlays drive resolution; we never inherit
    // from the parent.
    extends: child.extends,
    overlays: child.overlays
  };
}

async function readYaml(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (err) {
    throw new CriteriaFileNotFoundError(path);
  }
  try {
    return parseYaml(text);
  } catch (err) {
    throw new CriteriaYamlParseError(
      `Failed to parse YAML at ${path}: ${(err as Error).message}`,
      err
    );
  }
}

// `kind` parameter exists on resolveReferencePath for routing template
// vs overlay cache subdirs but local resolution is identical. Keep the
// helper exported for tests/consumers.
void (undefined as unknown as ReferenceKind);
