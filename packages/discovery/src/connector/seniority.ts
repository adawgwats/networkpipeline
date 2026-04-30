import type { SeniorityBand } from "@networkpipeline/criteria";

/**
 * Best-effort seniority extraction from a posting title. Multiple
 * matches OK ("Senior or Staff Software Engineer" -> ["senior", "staff"]).
 *
 * Errs on the side of returning ALL matches; the post-extraction stage
 * (`extractJobFacts`) refines based on full body. Pre-extraction gate
 * code uses these to decide rejection only when ALL signals are
 * blocked, so over-matching here is safe.
 */
export function inferSeniorityFromTitle(title: string): SeniorityBand[] {
  const out = new Set<SeniorityBand>();
  const lower = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(lower)) out.add("intern");
  if (/\bnew[\s-]?grad\b|\bentry[\s-]?level\b/.test(lower)) out.add("new_grad");
  if (/\b(junior|jr\.?)\b/.test(lower)) out.add("junior");
  if (/\b(mid|mid[\s-]?level)\b/.test(lower)) out.add("mid");
  if (/\bsenior\b|\bsr\.?\b/.test(lower)) out.add("senior");
  if (/\bstaff\b/.test(lower)) out.add("staff");
  if (/\bprincipal\b/.test(lower)) out.add("principal");
  if (/\bdirector\b/.test(lower)) out.add("director");
  if (/\bvp\b|\bvice\s+president\b/.test(lower)) out.add("vp");
  return [...out];
}
