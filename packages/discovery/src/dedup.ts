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
