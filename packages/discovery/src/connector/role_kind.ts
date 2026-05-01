import type { RoleKind } from "@networkpipeline/criteria";

/**
 * Best-effort title -> RoleKind classifier. Pure regex, no LLM, no
 * description body needed. Returns ALL matched kinds.
 *
 * Multi-tag is intentional: a "Senior Security Engineer" matches BOTH
 * `engineering` AND `security`; a "Solutions Engineer" matches BOTH
 * `engineering` AND `sales`. The user's blocklist (must_not_have.role_kind)
 * decides which tags reject — over-tagging is the safe failure mode.
 *
 * Returns `["other"]` when nothing matches. Pre-extraction treats this
 * as a defer (no rejection) — same defer-on-ambiguity contract as
 * role_seniority with empty signals.
 *
 * Order of regex blocks below is irrelevant — every match contributes;
 * dedup happens via Set.
 */
export function inferRoleKindsFromTitle(title: string): RoleKind[] {
  if (!title || title.trim().length === 0) return ["other"];
  const lower = title.toLowerCase();
  const out = new Set<RoleKind>();

  // ── engineering ──────────────────────────────────────────────────
  // Catches "Software Engineer", "Backend Engineer", "Full-Stack Eng",
  // "Engineering Manager", "SWE", "SDE", and the common "<seniority>
  // Engineer" / "Engineer, <area>" shapes. Deliberately broad — sales
  // and customer-success roles often borrow "engineer" (Solutions
  // Engineer, Sales Engineer); they get tagged BOTH so the blocklist
  // can route correctly.
  if (
    /\b(software|backend|frontend|full[\s-]?stack|web|mobile|ios|android|systems|distributed|cloud|platform|api)[\s-]+(engineer|developer|swe|sde)\b/.test(
      lower
    ) ||
    /\b(swe|sde)\b/.test(lower) ||
    /\b(engineer|engineering)\b/.test(lower) ||
    /\b(developer)\b/.test(lower) ||
    /\b(software architect|technical lead|tech lead)\b/.test(lower)
  ) {
    out.add("engineering");
  }

  // ── research ─────────────────────────────────────────────────────
  if (
    /\bresearch (engineer|scientist|associate|fellow|lead|manager|director)\b/.test(
      lower
    ) ||
    /\b(researcher|research intern)\b/.test(lower) ||
    /\bmember of technical staff\b/.test(lower)
  ) {
    out.add("research");
  }

  // ── ml ───────────────────────────────────────────────────────────
  // ML / AI / applied-scientist roles. We deliberately tag these as
  // `ml` AND `engineering` when "engineer" appears so that a blocklist
  // of `[sales, marketing, ...]` (which excludes `ml`) lets them pass.
  if (
    /\b(ml|machine[\s-]?learning|ai|applied[\s-]?(ml|ai|scientist)|deep[\s-]?learning|nlp|computer[\s-]?vision|model)\b.*\b(engineer|scientist|researcher|developer|architect)\b/.test(
      lower
    ) ||
    /\b(data scientist|ai engineer|ml engineer|mlops)\b/.test(lower)
  ) {
    out.add("ml");
  }

  // ── infrastructure ───────────────────────────────────────────────
  if (
    /\b(infrastructure|infra|platform|sre|site[\s-]?reliability|devops|cloud|kubernetes|distributed[\s-]?systems)[\s-]+(engineer|architect|specialist)\b/.test(
      lower
    ) ||
    /\b(infrastructure engineer|platform engineer|sre|reliability engineer|devops engineer|cloud engineer)\b/.test(
      lower
    ) ||
    /\bmember of technical staff,?\s+(infrastructure|platform|distributed)\b/.test(
      lower
    )
  ) {
    out.add("infrastructure");
    out.add("engineering");
  }

  // ── security ─────────────────────────────────────────────────────
  // Security roles also get the engineering tag — most postings are
  // engineering-flavored even when they're labeled "Security Engineer"
  // or "AppSec Researcher".
  if (
    /\b(security|appsec|infosec|cyber[\s-]?security|product[\s-]?security|application[\s-]?security)\b.*\b(engineer|architect|researcher|analyst|specialist|lead|manager)\b/.test(
      lower
    ) ||
    /\b(security engineer|security researcher|security architect|appsec engineer|infosec engineer)\b/.test(
      lower
    )
  ) {
    out.add("security");
    out.add("engineering");
  }

  // ── design ───────────────────────────────────────────────────────
  if (
    /\b(designer|ux|ui|product[\s-]?designer|visual[\s-]?designer|interaction[\s-]?designer|design[\s-]?lead)\b/.test(
      lower
    )
  ) {
    out.add("design");
  }

  // ── product ──────────────────────────────────────────────────────
  // Be careful: PM is too generic — only match when in the context of
  // a job title (start/end of word, paired with "manager", or as TPM/PM
  // in a product context). The lone "pm" alone is too noisy.
  if (
    /\bproduct[\s-]?(manager|owner|lead|director)\b/.test(lower) ||
    /\b(tpm|technical[\s-]?program[\s-]?manager|technical[\s-]?product[\s-]?manager)\b/.test(
      lower
    ) ||
    /\b(group product manager|gpm)\b/.test(lower)
  ) {
    out.add("product");
  }

  // ── sales ────────────────────────────────────────────────────────
  if (
    /\b(account[\s-]?executive|ae|sdr|bdr|account[\s-]?manager|sales[\s-]?(engineer|manager|representative|rep|lead|director|specialist)|business[\s-]?development|sales[\s-]?development)\b/.test(
      lower
    ) ||
    /\b(solutions[\s-]?(engineer|architect|consultant))\b/.test(lower) ||
    /\b(enterprise sales|sales|inside sales|outbound sales)\b/.test(lower)
  ) {
    out.add("sales");
    // Solutions Engineer / Sales Engineer also tag as engineering so
    // a search blocking sales but NOT engineering can still surface
    // the engineering side; that conflict is for the user's blocklist
    // to decide.
    if (/\bsolutions[\s-]?engineer|sales[\s-]?engineer\b/.test(lower)) {
      out.add("engineering");
    }
  }

  // ── customer_success ─────────────────────────────────────────────
  if (
    /\b(customer[\s-]?success|customer[\s-]?experience|onboarding|implementation[\s-]?(specialist|engineer|consultant|manager)|cx|csm)\b/.test(
      lower
    ) ||
    /\bcustomer[\s-]?(experience|success|support|operations)[\s-]?(manager|lead|director)\b/.test(
      lower
    )
  ) {
    out.add("customer_success");
    if (/\bimplementation[\s-]?engineer\b/.test(lower)) {
      out.add("engineering");
    }
  }

  // ── marketing ────────────────────────────────────────────────────
  if (
    /\b(marketing|brand|growth|content[\s-]?(strategist|writer|marketer|marketing|lead|director)|seo|community[\s-]?manager|product[\s-]?marketing)\b/.test(
      lower
    ) ||
    /\b(marketing manager|marketing lead|marketing director|growth manager|brand manager|head of marketing)\b/.test(
      lower
    )
  ) {
    out.add("marketing");
  }

  // ── recruiting ───────────────────────────────────────────────────
  if (
    /\b(recruiter|recruiting|talent[\s-]?(acquisition|partner|sourcer)|sourcer|technical[\s-]?recruiter|head[\s-]?of[\s-]?talent)\b/.test(
      lower
    )
  ) {
    out.add("recruiting");
  }

  // ── people_ops ───────────────────────────────────────────────────
  if (
    /\b(people[\s-]?(operations|ops|partner|team)|hr|hrbp|human[\s-]?resources|people[\s-]?(manager|lead|director)|head[\s-]?of[\s-]?people|chief[\s-]?people[\s-]?officer)\b/.test(
      lower
    )
  ) {
    out.add("people_ops");
  }

  // ── finance ──────────────────────────────────────────────────────
  if (
    /\b(finance|accountant|accounting|fp&a|controller|treasur(y|er)|tax[\s-]?(manager|analyst|director)|cfo|head[\s-]?of[\s-]?finance|financial[\s-]?(analyst|planner))\b/.test(
      lower
    )
  ) {
    out.add("finance");
  }

  // ── legal ────────────────────────────────────────────────────────
  if (
    /\b(counsel|lawyer|legal[\s-]?(ops|operations|counsel|director|manager)|paralegal|privacy[\s-]?counsel|general[\s-]?counsel)\b/.test(
      lower
    )
  ) {
    out.add("legal");
  }

  // ── operations ───────────────────────────────────────────────────
  if (
    /\b(bizops|business[\s-]?(operations|ops|analyst)|chief[\s-]?of[\s-]?staff|strategy[\s-]?(operations|ops|lead|manager|director)|operations[\s-]?(manager|lead|director|analyst)|coo|head[\s-]?of[\s-]?operations|revenue[\s-]?operations|revops)\b/.test(
      lower
    )
  ) {
    out.add("operations");
  }

  // ── support ──────────────────────────────────────────────────────
  if (
    /\b(support[\s-]?(engineer|specialist|representative|manager|lead|director)|technical[\s-]?support|help[\s-]?desk|customer[\s-]?support[\s-]?engineer)\b/.test(
      lower
    )
  ) {
    out.add("support");
    if (/\b(support[\s-]?engineer|technical[\s-]?support[\s-]?engineer)\b/.test(lower)) {
      out.add("engineering");
    }
  }

  // ── data ─────────────────────────────────────────────────────────
  if (
    /\b(data[\s-]?(engineer|analyst|architect|platform[\s-]?engineer)|analytics[\s-]?engineer|analytics[\s-]?(analyst|lead|manager)|business[\s-]?intelligence|bi[\s-]?(engineer|analyst|developer))\b/.test(
      lower
    )
  ) {
    out.add("data");
    if (
      /\b(data[\s-]?engineer|analytics[\s-]?engineer|data[\s-]?platform[\s-]?engineer)\b/.test(
        lower
      )
    ) {
      out.add("engineering");
    }
  }

  // ── devrel ───────────────────────────────────────────────────────
  if (
    /\b(developer[\s-]?(advocate|relations|experience|evangelist)|devrel|dx[\s-]?engineer|community[\s-]?(engineer|advocate))\b/.test(
      lower
    )
  ) {
    out.add("devrel");
  }

  // ── policy ───────────────────────────────────────────────────────
  if (
    /\b(policy[\s-]?(manager|lead|analyst|director|advisor)|trust[\s\-_]?(and[\s-]?)?safety|t&s|public[\s-]?affairs|government[\s-]?affairs|public[\s-]?policy|head[\s-]?of[\s-]?policy)\b/.test(
      lower
    )
  ) {
    out.add("policy");
  }

  if (out.size === 0) return ["other"];
  return [...out];
}
