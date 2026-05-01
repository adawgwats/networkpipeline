import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { greenhouseConnector } from "../connectors/greenhouse.js";
import type { FetchImpl } from "../connector/types.js";

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  throwError?: Error;
}): FetchImpl {
  return (async (_input: unknown) => {
    if (response.throwError) throw response.throwError;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      async json() {
        if (response.json instanceof Error) throw response.json;
        return response.json;
      }
    } as unknown as Response;
  }) as FetchImpl;
}

const FIXTURE_RESPONSE = {
  jobs: [
    {
      id: 4567890,
      title: "Senior Backend Engineer",
      content:
        "<p>We are looking for a <strong>senior</strong> engineer.</p><ul><li>5+ YoE</li></ul>",
      absolute_url:
        "https://boards.greenhouse.io/acme/jobs/4567890",
      location: { name: "San Francisco, CA" },
      departments: [{ id: 1, name: "Engineering" }],
      offices: [
        { id: 1, name: "SF HQ", location: "San Francisco, CA" }
      ],
      metadata: [
        { id: 1, name: "Employment Type", value: "Full-time" },
        { id: 2, name: "Salary", value: "$200k" }
      ],
      updated_at: "2024-04-01T12:00:00Z"
    },
    {
      id: 4567891,
      title: "Staff Frontend Engineer",
      content: "<div>Remote-friendly</div>",
      absolute_url:
        "https://boards.greenhouse.io/acme/jobs/4567891",
      location: { name: "Remote" },
      offices: [{ id: 2, name: "Remote", location: "Remote" }],
      metadata: [
        { id: 1, name: "Employment Type", value: "Contract" }
      ]
    }
  ]
};

describe("greenhouseConnector", () => {
  it("identifies as 'greenhouse' direct connector", () => {
    const c = greenhouseConnector();
    assert.equal(c.id(), "greenhouse");
    assert.equal(c.kind, "direct");
  });

  it("normalizes a typical Greenhouse response", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ json: FIXTURE_RESPONSE })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.kind, "direct_fetch_result");
    assert.equal(result.source, "greenhouse");
    assert.equal(result.errors.length, 0);
    assert.equal(result.postings.length, 2);

    const a = result.postings[0];
    assert.equal(a.external_ref, "4567890");
    assert.equal(a.title, "Senior Backend Engineer");
    assert.equal(a.company, "acme");
    assert.equal(a.url, "https://boards.greenhouse.io/acme/jobs/4567890");
    assert.deepEqual(a.onsite_locations, ["San Francisco, CA"]);
    assert.equal(a.is_onsite_required, true);
    assert.equal(a.employment_type, "full_time");
    assert.deepEqual(a.inferred_seniority_signals, ["senior"]);
    assert.match(a.description_excerpt ?? "", /senior engineer/);
    assert.doesNotMatch(a.description_excerpt ?? "", /<p>/);

    const b = result.postings[1];
    assert.equal(b.is_onsite_required, false);
    assert.deepEqual(b.onsite_locations, []);
    assert.equal(b.employment_type, "contract");
    assert.deepEqual(b.inferred_seniority_signals, ["staff"]);
  });

  it("returns empty postings + error on HTTP 404", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ ok: false, status: 404 })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "doesnotexist"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /404/);
  });

  it("returns empty postings + error on HTTP 500", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ ok: false, status: 500 })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("returns empty postings + error on malformed payload (missing jobs)", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ json: { not_jobs: [] } })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /malformed/);
  });

  it("returns empty postings + error on network exception", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ throwError: new Error("ENOTFOUND") })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /ENOTFOUND/);
  });

  it("returns empty postings + error on JSON parse failure", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ json: new Error("invalid json") })
    });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /JSON parse failed/);
  });

  it("rejects wrong query.source with an error result, not throw", async () => {
    const c = greenhouseConnector({
      fetchImpl: mockFetch({ json: FIXTURE_RESPONSE })
    });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("respects maxResults cap by truncating after mapping", async () => {
    // Mock returns 100 jobs; max_results=10 → 10 returned.
    const manyJobs = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      title: `Software Engineer ${i + 1}`,
      content: "<p>Build things.</p>",
      absolute_url: `https://boards-api.greenhouse.io/acme/jobs/${i + 1}`,
      location: { name: "Remote" },
      offices: [{ location: "Remote" }],
      metadata: []
    }));
    const stub = mockFetch({ json: { jobs: manyJobs } });
    const c = greenhouseConnector({ fetchImpl: stub });
    const result = await c.discoverDirect(
      { source: "greenhouse", company_slug: "acme" },
      10
    );
    assert.equal(result.postings.length, 10);
    // Truncation preserves source order — first 10 jobs should remain.
    assert.equal(result.postings[0].external_ref, "1");
    assert.equal(result.postings[9].external_ref, "10");
  });

  it("falls back to DEFAULT_MAX_RESULTS (50) when no cap supplied", async () => {
    const manyJobs = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      title: `Software Engineer ${i + 1}`,
      content: "<p>x</p>",
      absolute_url: `https://example.com/${i + 1}`,
      location: { name: "Remote" },
      offices: [{ location: "Remote" }],
      metadata: []
    }));
    const stub = mockFetch({ json: { jobs: manyJobs } });
    const c = greenhouseConnector({ fetchImpl: stub });
    const result = await c.discoverDirect({
      source: "greenhouse",
      company_slug: "acme"
    });
    assert.equal(result.postings.length, 50);
  });

  it("constructs the correct URL", async () => {
    let capturedUrl = "";
    const stub: FetchImpl = (async (input: unknown) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        async json() {
          return { jobs: [] };
        }
      } as unknown as Response;
    }) as FetchImpl;
    const c = greenhouseConnector({ fetchImpl: stub });
    await c.discoverDirect({ source: "greenhouse", company_slug: "acme" });
    assert.equal(
      capturedUrl,
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"
    );
  });
});
