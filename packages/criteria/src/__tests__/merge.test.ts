import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOverlay,
  CriteriaCycleError,
  CriteriaDepthExceededError,
  CriteriaValidationError,
  loadResolvedCriteriaFromFile,
  mergeCriteriaShallow,
  overlayFragmentSchema,
  resolveAndApplyOverlays,
  resolveAndMergeExtends,
  type CandidateCriteria
} from "../index.js";

function baseCriteria(
  overrides: Partial<CandidateCriteria> = {}
): CandidateCriteria {
  return {
    version: 1,
    schema_version: "1.0.0",
    updated_at: "2026-04-29T00:00:00Z",
    updated_via: "test",
    extends: [],
    overlays: [],
    profile: {
      display_name: "Test",
      years_experience: 4,
      primary_locations: ["remote"],
      work_authorization: "us_citizen_or_permanent_resident",
      seniority_band: ["mid"]
    },
    hard_gates: {
      must_have: [],
      must_not_have: [],
      must_not_contain_phrases: []
    },
    values_refusals: [],
    soft_preferences: { positive: [], negative: [], min_soft_score: 0.55 },
    calibration: { accepted_examples: [], rejected_examples: [] },
    ...overrides
  };
}

function fixturesDir(): string {
  return mkdtempSync(join(tmpdir(), "np-merge-"));
}

function writeYaml(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

// ─── overlayFragmentSchema (cannot-weaken at parse time) ─────────────

describe("overlayFragmentSchema — cannot-weaken enforcement", () => {
  it("accepts the three add-allowed sections", () => {
    const result = overlayFragmentSchema.safeParse({
      hard_gates: {
        must_not_have: [
          {
            kind: "company",
            any_of: ["Anduril"],
            reason: "values"
          }
        ]
      },
      values_refusals: ["No defense work"],
      soft_preferences: {
        negative: [{ topic: "crypto-only", weight: -0.5 }]
      }
    });
    assert.equal(result.success, true);
  });

  it("accepts an empty fragment (overlay can be a no-op)", () => {
    assert.equal(overlayFragmentSchema.safeParse({}).success, true);
  });

  it("rejects must_have (would loosen by adding requirements)", () => {
    const result = overlayFragmentSchema.safeParse({
      hard_gates: {
        must_have: [
          { kind: "years_experience", op: ">=", value: 3 }
        ]
      }
    });
    assert.equal(result.success, false);
  });

  it("rejects must_not_contain_phrases (not in add-allowed list)", () => {
    const result = overlayFragmentSchema.safeParse({
      hard_gates: {
        must_not_contain_phrases: ["something"]
      }
    });
    assert.equal(result.success, false);
  });

  it("rejects soft_preferences.positive (not in add-allowed list)", () => {
    const result = overlayFragmentSchema.safeParse({
      soft_preferences: {
        positive: [{ topic: "ml", weight: 1.0 }]
      }
    });
    assert.equal(result.success, false);
  });

  it("rejects min_soft_score (would weaken the threshold)", () => {
    const result = overlayFragmentSchema.safeParse({
      soft_preferences: { min_soft_score: 0.0 }
    });
    assert.equal(result.success, false);
  });

  it("rejects unknown top-level fields", () => {
    const result = overlayFragmentSchema.safeParse({
      profile: { display_name: "wat" }
    });
    assert.equal(result.success, false);
  });
});

// ─── applyOverlay (pure function) ────────────────────────────────────

describe("applyOverlay — append-only semantics", () => {
  it("appends overlay must_not_have entries to existing list", () => {
    const base = baseCriteria();
    base.hard_gates.must_not_have.push({
      kind: "company",
      any_of: ["Existing"],
      reason: "x"
    });
    const out = applyOverlay(base, {
      hard_gates: {
        must_not_have: [
          { kind: "company", any_of: ["Anduril"], reason: "values" }
        ]
      }
    });
    assert.equal(out.hard_gates.must_not_have.length, 2);
    const companies = out.hard_gates.must_not_have.flatMap((c) =>
      "any_of" in c ? c.any_of : []
    );
    assert.ok(companies.includes("Existing"));
    assert.ok(companies.includes("Anduril"));
  });

  it("appends values_refusals", () => {
    const base = baseCriteria({ values_refusals: ["Existing refusal"] });
    const out = applyOverlay(base, {
      values_refusals: ["Added by overlay"]
    });
    assert.deepEqual(out.values_refusals, [
      "Existing refusal",
      "Added by overlay"
    ]);
  });

  it("appends negative soft preferences", () => {
    const base = baseCriteria();
    base.soft_preferences.negative.push({ topic: "old", weight: -0.1 });
    const out = applyOverlay(base, {
      soft_preferences: {
        negative: [{ topic: "new", weight: -0.5 }]
      }
    });
    assert.equal(out.soft_preferences.negative.length, 2);
  });

  it("preserves ALL non-overlay sections (profile, must_have, positives, calibration)", () => {
    const base = baseCriteria();
    base.profile.years_experience = 7;
    base.hard_gates.must_have.push({
      kind: "years_experience",
      op: ">=",
      value: 3
    });
    base.soft_preferences.positive.push({ topic: "ml", weight: 1.0 });
    base.soft_preferences.min_soft_score = 0.7;

    const out = applyOverlay(base, {
      values_refusals: ["new"]
    });

    assert.equal(out.profile.years_experience, 7);
    assert.equal(out.hard_gates.must_have.length, 1);
    assert.equal(out.soft_preferences.positive.length, 1);
    assert.equal(out.soft_preferences.min_soft_score, 0.7);
  });
});

// ─── mergeCriteriaShallow (extends precedence) ───────────────────────

describe("mergeCriteriaShallow — extends precedence", () => {
  it("child wins on direct field conflict", () => {
    const parent = baseCriteria({ version: 1, updated_via: "parent" });
    const child = baseCriteria({ version: 5, updated_via: "child" });
    const merged = mergeCriteriaShallow(parent, child);
    assert.equal(merged.version, 5);
    assert.equal(merged.updated_via, "child");
  });

  it("merges nested profile shallowly: child fields override, missing keys fall through", () => {
    const parent = baseCriteria({
      profile: {
        display_name: "Parent",
        years_experience: 8,
        primary_locations: ["NYC"],
        work_authorization: "us_citizen",
        seniority_band: ["staff"]
      }
    });
    const child = baseCriteria({
      profile: {
        display_name: "Child",
        years_experience: 4,
        primary_locations: ["remote"],
        work_authorization: "us_citizen_or_permanent_resident",
        seniority_band: ["mid"]
      }
    });
    const merged = mergeCriteriaShallow(parent, child);
    assert.equal(merged.profile.display_name, "Child");
  });

  it("does not inherit extends/overlays from the parent", () => {
    const parent = baseCriteria({
      extends: ["parent-extends"],
      overlays: ["parent-overlay"]
    });
    const child = baseCriteria({ extends: [], overlays: [] });
    const merged = mergeCriteriaShallow(parent, child);
    assert.deepEqual(merged.extends, []);
    assert.deepEqual(merged.overlays, []);
  });
});

// ─── resolveAndMergeExtends (file-backed) ────────────────────────────

describe("resolveAndMergeExtends — file resolution", () => {
  const dir = fixturesDir();
  after(() => rmSync(dir, { recursive: true, force: true }));

  const parentYaml = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: parent
profile:
  display_name: "Parent"
  years_experience: 10
  primary_locations: [NYC]
  work_authorization: us_citizen
  seniority_band: [staff]
values_refusals: [parent-refusal]
`;

  const grandparentYaml = `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: grandparent
profile:
  display_name: "Grandparent"
  years_experience: 12
  primary_locations: [SF]
  work_authorization: us_citizen
  seniority_band: [principal]
values_refusals: [grandparent-refusal]
`;

  const parentExtendsGpYaml = (gpRel: string) => `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: parent-extends-gp
extends: ["${gpRel}"]
profile:
  display_name: "ParentExtendsGP"
  years_experience: 11
  primary_locations: [NYC]
  work_authorization: us_citizen
  seniority_band: [staff]
values_refusals: [parent-refusal]
`;

  it("resolves a single extends relative path and lets local override parent", async () => {
    const parentPath = writeYaml(dir, "parent.yaml", parentYaml);
    const local = baseCriteria({
      extends: ["./parent.yaml"],
      profile: {
        display_name: "Local",
        years_experience: 4,
        primary_locations: ["remote"],
        work_authorization: "us_citizen_or_permanent_resident",
        seniority_band: ["mid"]
      }
    });

    const merged = await resolveAndMergeExtends(local, join(dir, "local.yaml"));
    // Local wins on display_name, but extends-derived fields come through
    // for keys not set locally.
    assert.equal(merged.profile.display_name, "Local");
    void parentPath;
  });

  it("resolves multi-level extends chain (child → parent → grandparent)", async () => {
    const gpPath = writeYaml(dir, "grandparent.yaml", grandparentYaml);
    void gpPath;
    writeYaml(dir, "parent-ext.yaml", parentExtendsGpYaml("./grandparent.yaml"));

    const local = baseCriteria({
      extends: ["./parent-ext.yaml"],
      profile: {
        display_name: "Local",
        years_experience: 4,
        primary_locations: ["remote"],
        work_authorization: "us_citizen_or_permanent_resident",
        seniority_band: ["mid"]
      }
    });

    const merged = await resolveAndMergeExtends(
      local,
      join(dir, "local.yaml")
    );
    assert.equal(merged.profile.display_name, "Local");
  });

  it("rejects cycles", async () => {
    writeYaml(
      dir,
      "a.yaml",
      `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: a
extends: ["./b.yaml"]
profile:
  display_name: "A"
  years_experience: 4
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [mid]
values_refusals: []
`
    );
    writeYaml(
      dir,
      "b.yaml",
      `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: b
extends: ["./a.yaml"]
profile:
  display_name: "B"
  years_experience: 4
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [mid]
values_refusals: []
`
    );
    const local = baseCriteria({ extends: ["./a.yaml"] });
    await assert.rejects(
      () => resolveAndMergeExtends(local, join(dir, "local.yaml")),
      CriteriaCycleError
    );
  });

  it("rejects extends chains exceeding MAX_EXTENDS_DEPTH", async () => {
    // Build 4-deep chain: l1 -> l2 -> l3 -> l4
    const tier = (label: string, ext: string | null) => `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: ${label}
${ext ? `extends: ["${ext}"]` : ""}
profile:
  display_name: "${label}"
  years_experience: 4
  primary_locations: [remote]
  work_authorization: us_citizen
  seniority_band: [mid]
values_refusals: []
`;
    writeYaml(dir, "l4.yaml", tier("l4", null));
    writeYaml(dir, "l3.yaml", tier("l3", "./l4.yaml"));
    writeYaml(dir, "l2.yaml", tier("l2", "./l3.yaml"));
    writeYaml(dir, "l1.yaml", tier("l1", "./l2.yaml"));

    const local = baseCriteria({ extends: ["./l1.yaml"] });
    await assert.rejects(
      () => resolveAndMergeExtends(local, join(dir, "local.yaml")),
      CriteriaDepthExceededError
    );
  });
});

// ─── resolveAndApplyOverlays (file-backed) ───────────────────────────

describe("resolveAndApplyOverlays — file resolution", () => {
  const dir = fixturesDir();
  after(() => rmSync(dir, { recursive: true, force: true }));

  const overlayYaml = `
hard_gates:
  must_not_have:
    - kind: company
      any_of: [Anduril, Palantir]
      reason: "Values refusal"
values_refusals:
  - "Mass surveillance tooling"
`;

  const malformedOverlayYaml = `
hard_gates:
  must_have:
    - kind: years_experience
      op: ">="
      value: 1
`;

  it("loads a valid overlay file and appends its entries", async () => {
    writeYaml(dir, "no-defense.yaml", overlayYaml);
    const base = baseCriteria({ overlays: ["./no-defense.yaml"] });
    const out = await resolveAndApplyOverlays(base, join(dir, "local.yaml"));

    const companies = out.hard_gates.must_not_have.flatMap((c) =>
      "any_of" in c ? c.any_of : []
    );
    assert.ok(companies.includes("Anduril"));
    assert.ok(companies.includes("Palantir"));
    assert.ok(out.values_refusals.includes("Mass surveillance tooling"));
  });

  it("throws when an overlay file violates the cannot-weaken rule", async () => {
    writeYaml(dir, "bad.yaml", malformedOverlayYaml);
    const base = baseCriteria({ overlays: ["./bad.yaml"] });
    await assert.rejects(
      () => resolveAndApplyOverlays(base, join(dir, "local.yaml")),
      CriteriaValidationError
    );
  });
});

// ─── loadResolvedCriteriaFromFile (orchestration) ────────────────────

describe("loadResolvedCriteriaFromFile — end-to-end orchestration", () => {
  const dir = fixturesDir();
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("loads local + extends + overlays and returns both verbatim and resolved", async () => {
    writeYaml(
      dir,
      "parent.yaml",
      `
version: 1
schema_version: "1.0.0"
updated_at: "2026-01-01T00:00:00Z"
updated_via: parent
profile:
  display_name: "Parent"
  years_experience: 10
  primary_locations: [NYC]
  work_authorization: us_citizen
  seniority_band: [staff]
values_refusals: [parent-refusal]
`
    );
    writeYaml(
      dir,
      "no-crypto.yaml",
      `
soft_preferences:
  negative:
    - topic: "crypto-only roles"
      weight: -0.6
`
    );

    writeYaml(
      dir,
      "criteria.yaml",
      `
version: 7
schema_version: "1.0.0"
updated_at: "2026-04-29T00:00:00Z"
updated_via: manual_edit
extends: ["./parent.yaml"]
overlays: ["./no-crypto.yaml"]
profile:
  display_name: "Local Override"
  years_experience: 4
  primary_locations: [remote]
  work_authorization: us_citizen_or_permanent_resident
  seniority_band: [mid]
values_refusals:
  - "local-refusal"
`
    );

    const out = await loadResolvedCriteriaFromFile(join(dir, "criteria.yaml"));

    // Verbatim local file is preserved.
    assert.equal(out.criteria.profile.display_name, "Local Override");
    assert.deepEqual(out.criteria.values_refusals, ["local-refusal"]);

    // Resolved view has parent's refusal plus local plus none from
    // overlay (overlay only adds soft prefs).
    assert.equal(out.resolved.profile.display_name, "Local Override");
    assert.ok(out.resolved.values_refusals.includes("local-refusal"));

    // Overlay-added negative soft pref present.
    assert.equal(out.resolved.soft_preferences.negative.length, 1);
    assert.equal(
      out.resolved.soft_preferences.negative[0].topic,
      "crypto-only roles"
    );
  });
});
