import { createHash } from "node:crypto";
import type { NormalizedDiscoveredPosting } from "./connector/types.js";

/**
 * Tracking-param prefixes stripped from query strings during URL
 * canonicalization. Anything starting with one of these is removed
 * before reconstruction.
 */
const TRACKING_PARAM_PREFIXES = [
  "utm_",
  "_hsenc",
  "_hsmi",
  "mc_",
  "fbclid",
  "gclid"
];

/**
 * Exact-match tracking param keys stripped during canonicalization.
 * These are common analytics params that don't affect routing.
 */
const TRACKING_PARAM_EXACT = new Set(["ref", "source", "trk", "trkInfo"]);

function isTrackingParam(key: string): boolean {
  if (TRACKING_PARAM_EXACT.has(key)) return true;
  for (const prefix of TRACKING_PARAM_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Canonicalize a posting URL for cross-source dedup lookup.
 * - Lowercase host
 * - Strip a known set of tracking params: utm_*, _hsenc, _hsmi, mc_*,
 *   fbclid, gclid, ref, source, trk, trkInfo. We intentionally do NOT
 *   strip params required by the source for routing.
 * - Remove trailing slash from the path (but keep "/" for root)
 * - Drop fragments
 * Returns the canonical URL or the input unchanged if parsing fails.
 */
export function canonicalizeUrl(input: string): string {
  if (!input) return input;
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return input;
  }

  // Lowercase host
  parsed.hostname = parsed.hostname.toLowerCase();

  // Drop fragment
  parsed.hash = "";

  // Strip tracking params
  const toDelete: string[] = [];
  parsed.searchParams.forEach((_, key) => {
    if (isTrackingParam(key)) toDelete.push(key);
  });
  for (const key of toDelete) parsed.searchParams.delete(key);

  // Remove trailing slash from path (but keep root "/")
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  }

  return parsed.toString();
}

/**
 * Compute a stable extraction-cache key for a posting. The hash covers
 * the body that the LLM extractor sees (title + company + first 2KB of
 * the description excerpt) and is criteria-agnostic — exactly what
 * `extractor_version` + `input_hash` keys the job_evaluations cache by.
 *
 * Used by the orchestrator's three-branch dedup logic in
 * `recordDiscoveredPostings`:
 *   - same input_hash + same criteria_version → mark duplicate, skip
 *   - same input_hash + DIFFERENT criteria_version → reuse facts, skip
 *     extract LLM call, re-run gates+values+score against the new
 *     criteria
 *   - no match → run the full pipeline
 *
 * Lowercases and trims so trivial whitespace differences don't bust the
 * cache. The 2KB cap matches the size connectors store in
 * `description_excerpt`.
 */
export function computePostingInputHash(p: NormalizedDiscoveredPosting): string {
  const canonical = [
    p.title.trim().toLowerCase(),
    p.company.trim().toLowerCase(),
    (p.description_excerpt ?? "").slice(0, 2048).trim().toLowerCase()
  ].join("\n---\n");
  return createHash("sha256").update(canonical).digest("hex");
}
