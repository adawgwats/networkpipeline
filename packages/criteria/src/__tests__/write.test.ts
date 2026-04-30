import { strict as assert } from "node:assert";
import { describe, it, after } from "node:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  bumpVersion,
  CriteriaValidationError,
  loadCriteriaFromFile,
  parseCriteriaFromYaml,
  serializeCriteriaToYaml,
  writeCriteriaToFile,
  type CandidateCriteria
} from "../index.js";
import { validRichCriteriaYaml } from "./fixtures.js";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "np-write-"));
}

describe("serializeCriteriaToYaml", () => {
  it("produces YAML that round-trips through parseCriteriaFromYaml", () => {
    const original = parseCriteriaFromYaml(validRichCriteriaYaml);
    const yaml = serializeCriteriaToYaml(original);
    const reparsed = parseCriteriaFromYaml(yaml);
    // Equality check across the full structure.
    assert.deepEqual(reparsed, original);
  });

  it("re-validates before serializing — throws on a corrupted object", () => {
    const original = parseCriteriaFromYaml(validRichCriteriaYaml);
    // Mutate to make it invalid.
    const bad = {
      ...original,
      profile: { ...original.profile, years_experience: -1 }
    } as CandidateCriteria;
    assert.throws(() => serializeCriteriaToYaml(bad), CriteriaValidationError);
  });

  it("renders block-style sequences (one entry per line for diff-friendliness)", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const yaml = serializeCriteriaToYaml(criteria);
    // values_refusals has multiple entries; each should be on its own line
    // with a leading "  - " (block sequence). Reject inline-flow form
    // ("[a, b]") which is hostile to PR review.
    const refusalsBlock = yaml
      .split("\n")
      .filter((line) => line.trim().startsWith("- "));
    assert.ok(
      refusalsBlock.length >= 2,
      "expected multiple block-sequence entries"
    );
  });

  it("is byte-stable across repeated calls with the same input", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    assert.equal(
      serializeCriteriaToYaml(criteria),
      serializeCriteriaToYaml(criteria)
    );
  });
});

describe("bumpVersion", () => {
  it("increments version, refreshes updated_at, sets updated_via — does not mutate input", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const beforeVersion = criteria.version;
    const beforeUpdatedAt = criteria.updated_at;

    const bumped = bumpVersion(criteria, {
      updatedVia: "active_learning",
      now: new Date("2026-04-29T12:00:00Z")
    });

    assert.equal(bumped.version, beforeVersion + 1);
    assert.equal(bumped.updated_at, "2026-04-29T12:00:00.000Z");
    assert.equal(bumped.updated_via, "active_learning");

    // Input is NOT mutated.
    assert.equal(criteria.version, beforeVersion);
    assert.equal(criteria.updated_at, beforeUpdatedAt);
  });

  it("uses 'now' by default when no override is provided", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const start = Date.now();
    const bumped = bumpVersion(criteria, { updatedVia: "manual_edit" });
    const end = Date.now();
    const bumpedAt = Date.parse(bumped.updated_at);
    assert.ok(bumpedAt >= start - 1000);
    assert.ok(bumpedAt <= end + 1000);
  });

  it("preserves all non-versioning fields verbatim", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const bumped = bumpVersion(criteria, { updatedVia: "manual_edit" });

    assert.deepEqual(bumped.profile, criteria.profile);
    assert.deepEqual(bumped.hard_gates, criteria.hard_gates);
    assert.deepEqual(bumped.values_refusals, criteria.values_refusals);
    assert.deepEqual(bumped.soft_preferences, criteria.soft_preferences);
    assert.deepEqual(bumped.calibration, criteria.calibration);
  });

  it("accepts free-form updated_via strings (mapping to controlled vocabulary happens at the DB boundary)", () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const bumped = bumpVersion(criteria, {
      updatedVia: "some-future-author-tool"
    });
    assert.equal(bumped.updated_via, "some-future-author-tool");
  });
});

describe("writeCriteriaToFile — atomic write", () => {
  const dir = workdir();
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a valid YAML file that loadCriteriaFromFile can re-read", async () => {
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const target = join(dir, "criteria.yaml");

    const result = writeCriteriaToFile(criteria, { path: target });
    assert.equal(result.path, target);
    assert.ok(result.bytesWritten > 0);
    assert.ok(existsSync(target));

    const reloaded = await loadCriteriaFromFile(target);
    assert.deepEqual(reloaded.criteria, criteria);
  });

  it("creates the parent directory if missing", () => {
    const target = join(dir, "nested", "deeper", "criteria.yaml");
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    writeCriteriaToFile(criteria, { path: target });
    assert.ok(existsSync(target));
    assert.ok(existsSync(dirname(target)));
  });

  it("overwrites an existing file (in-place update)", () => {
    const target = join(dir, "overwrite.yaml");
    const v1 = parseCriteriaFromYaml(validRichCriteriaYaml);
    writeCriteriaToFile(v1, { path: target });
    const before = readFileSync(target, "utf-8");

    const v2 = bumpVersion(v1, {
      updatedVia: "manual_edit",
      now: new Date("2026-05-01T00:00:00Z")
    });
    writeCriteriaToFile(v2, { path: target });
    const after = readFileSync(target, "utf-8");

    assert.notEqual(before, after);
    assert.ok(after.includes(`version: ${v2.version}`));
  });

  it("does not leave a .tmp file behind on success", () => {
    const target = join(dir, "no-tmp.yaml");
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    writeCriteriaToFile(criteria, { path: target });

    assert.ok(readFileSync(target, "utf-8").length > 0);
    // List the directory and assert no leftover .tmp files matching
    // our naming convention.
    const leftovers = readdirSync(dirname(target)).filter((f) =>
      f.includes(".tmp.")
    );
    assert.equal(leftovers.length, 0);
  });

  it("refuses to write a corrupted criteria object (catches before disk)", () => {
    const target = join(dir, "should-never-exist.yaml");
    const criteria = parseCriteriaFromYaml(validRichCriteriaYaml);
    const bad = {
      ...criteria,
      profile: { ...criteria.profile, years_experience: -42 }
    } as CandidateCriteria;
    assert.throws(
      () => writeCriteriaToFile(bad, { path: target }),
      CriteriaValidationError
    );
    assert.ok(!existsSync(target), "no file should have been written");
  });
});

describe("end-to-end: load → bump → write → load", () => {
  const dir = workdir();
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("preserves the version chain across an active-learning style cycle", async () => {
    const target = join(dir, "criteria.yaml");

    // Write v1.
    const v1 = parseCriteriaFromYaml(validRichCriteriaYaml);
    const startingVersion = v1.version;
    writeCriteriaToFile(v1, { path: target });

    // Read it, bump it, write it back — three times, simulating three
    // accepted active-learning proposals.
    let current = (await loadCriteriaFromFile(target)).criteria;
    for (let i = 0; i < 3; i++) {
      current = bumpVersion(current, {
        updatedVia: "active_learning",
        now: new Date(`2026-05-0${i + 1}T00:00:00Z`)
      });
      writeCriteriaToFile(current, { path: target });
    }

    const finalLoaded = (await loadCriteriaFromFile(target)).criteria;
    assert.equal(finalLoaded.version, startingVersion + 3);
    assert.equal(finalLoaded.updated_via, "active_learning");
    // All non-versioning state preserved through the cycle.
    assert.deepEqual(finalLoaded.profile, v1.profile);
    assert.deepEqual(finalLoaded.values_refusals, v1.values_refusals);
  });
});
