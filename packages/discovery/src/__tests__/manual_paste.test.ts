import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { manualPasteConnector } from "../connectors/manual_paste.js";

describe("manualPasteConnector", () => {
  it("identifies as 'manual_paste'", () => {
    const c = manualPasteConnector();
    assert.equal(c.id(), "manual_paste");
    assert.equal(c.kind, "direct");
  });

  it("synthesizes a single posting from one URL", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "manual_paste",
      urls: ["https://example.com/job/1"]
    });
    assert.equal(out.kind, "direct_fetch_result");
    assert.equal(out.source, "manual_paste");
    assert.equal(out.errors.length, 0);
    assert.equal(out.postings.length, 1);
    const p = out.postings[0];
    assert.equal(p.url, "https://example.com/job/1");
    assert.equal(p.title, "Manual paste — see URL");
    assert.equal(p.company, "Unknown");
    assert.equal(p.external_ref, null);
    assert.deepEqual(p.raw_metadata, { url: "https://example.com/job/1" });
  });

  it("handles a batch of URLs", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "manual_paste",
      urls: [
        "https://example.com/job/1",
        "https://example.com/job/2",
        "https://example.com/job/3"
      ]
    });
    assert.equal(out.postings.length, 3);
    assert.equal(out.errors.length, 0);
    assert.deepEqual(
      out.postings.map((p) => p.url),
      [
        "https://example.com/job/1",
        "https://example.com/job/2",
        "https://example.com/job/3"
      ]
    );
  });

  it("returns empty postings and no errors on empty array", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "manual_paste",
      urls: []
    });
    assert.deepEqual(out.postings, []);
    assert.deepEqual(out.errors, []);
  });

  it("emits an error entry for malformed URLs", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "manual_paste",
      urls: ["https://valid.example.com/x", "not-a-url", "https://b.example.com/y"]
    });
    assert.equal(out.postings.length, 2);
    assert.equal(out.errors.length, 1);
    assert.equal(out.errors[0].work_item_index, 1);
    assert.match(out.errors[0].message, /malformed URL/);
  });

  it("applies canonicalizeUrl to incoming URLs (strips utm_*)", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "manual_paste",
      urls: ["https://EXAMPLE.com/job/1?utm_source=foo&keep=bar#frag"]
    });
    assert.equal(out.postings.length, 1);
    assert.equal(
      out.postings[0].url,
      "https://example.com/job/1?keep=bar"
    );
  });

  it("returns an error when query.source is wrong", async () => {
    const c = manualPasteConnector();
    const out = await c.discoverDirect({
      source: "lever",
      company_slug: "acme"
    });
    assert.equal(out.postings.length, 0);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0].message, /expected query\.source/);
  });
});
