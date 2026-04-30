import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allConnectors, connectorById } from "../registry.js";
import type { SourceId } from "../connector/types.js";

const ALL_IDS: SourceId[] = [
  "indeed",
  "greenhouse",
  "lever",
  "ashby",
  "career_page",
  "recruiter_email",
  "manual_paste"
];

describe("connector registry", () => {
  it("resolves every registered SourceId", () => {
    for (const id of ALL_IDS) {
      const c = connectorById(id);
      assert.ok(c, `connectorById missed ${id}`);
      assert.equal(c!.id(), id);
    }
  });

  it("returns undefined for unknown ids", () => {
    // Cast — exercise unknown-id path explicitly.
    assert.equal(
      connectorById("nope-not-real" as unknown as SourceId),
      undefined
    );
  });

  it("allConnectors returns one entry per registered SourceId", () => {
    const all = allConnectors();
    assert.equal(all.length, ALL_IDS.length);
    const ids = all.map((c) => c.id()).sort();
    assert.deepEqual(ids, [...ALL_IDS].sort());
  });

  it("each connector advertises a non-empty description", () => {
    for (const c of allConnectors()) {
      assert.ok(c.description().length > 0);
    }
  });
});
