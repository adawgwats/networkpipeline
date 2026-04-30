import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { leverConnector } from "../connectors/lever.js";
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

const FIXTURE_RESPONSE = [
  {
    id: "abc-123",
    text: "Senior Software Engineer",
    description: "<p>Build cool stuff.</p>",
    descriptionPlain: "Build cool stuff.",
    additional: "<p>Plus more.</p>",
    additionalPlain: "Plus more.",
    categories: {
      team: "Eng",
      department: "Engineering",
      location: "San Francisco",
      commitment: "Full-time",
      allLocations: ["San Francisco", "New York"]
    },
    hostedUrl: "https://jobs.lever.co/acme/abc-123",
    applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
    createdAt: 1700000000000
  },
  {
    id: "def-456",
    text: "Staff Engineer",
    descriptionPlain: "Remote OK.",
    categories: {
      location: "Remote",
      commitment: "Contract",
      allLocations: ["Remote"]
    },
    hostedUrl: "https://jobs.lever.co/acme/def-456"
  }
];

describe("leverConnector", () => {
  it("identifies as 'lever' direct connector", () => {
    const c = leverConnector();
    assert.equal(c.id(), "lever");
    assert.equal(c.kind, "direct");
  });

  it("normalizes a typical Lever response", async () => {
    const c = leverConnector({
      fetchImpl: mockFetch({ json: FIXTURE_RESPONSE })
    });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "acme"
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.postings.length, 2);

    const a = result.postings[0];
    assert.equal(a.source, "lever");
    assert.equal(a.external_ref, "abc-123");
    assert.equal(a.title, "Senior Software Engineer");
    assert.equal(a.company, "acme");
    assert.equal(a.url, "https://jobs.lever.co/acme/abc-123");
    assert.deepEqual(a.onsite_locations, ["San Francisco", "New York"]);
    assert.equal(a.is_onsite_required, true);
    assert.equal(a.employment_type, "full_time");
    assert.deepEqual(a.inferred_seniority_signals, ["senior"]);
    assert.match(a.description_excerpt ?? "", /Build cool stuff/);
    assert.match(a.description_excerpt ?? "", /Plus more/);

    const b = result.postings[1];
    assert.equal(b.is_onsite_required, false);
    assert.deepEqual(b.onsite_locations, []);
    assert.equal(b.employment_type, "contract");
  });

  it("returns empty postings + error on HTTP error", async () => {
    const c = leverConnector({
      fetchImpl: mockFetch({ ok: false, status: 404 })
    });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("returns empty postings + error on malformed payload", async () => {
    const c = leverConnector({
      fetchImpl: mockFetch({ json: { not_array: true } })
    });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /malformed/);
  });

  it("returns empty postings + error on network exception", async () => {
    const c = leverConnector({
      fetchImpl: mockFetch({ throwError: new Error("boom") })
    });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("falls back to applyUrl when hostedUrl is missing", async () => {
    const payload = [
      {
        id: "x",
        text: "Engineer",
        descriptionPlain: "x",
        applyUrl: "https://jobs.lever.co/acme/x/apply",
        categories: { commitment: "Full-time" }
      }
    ];
    const c = leverConnector({ fetchImpl: mockFetch({ json: payload }) });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "acme"
    });
    assert.equal(
      result.postings[0].url,
      "https://jobs.lever.co/acme/x/apply"
    );
  });

  it("uses 'lever' fallback URL even when both hostedUrl and applyUrl missing", async () => {
    const payload = [{ id: "y", text: "Engineer" }];
    const c = leverConnector({ fetchImpl: mockFetch({ json: payload }) });
    const result = await c.discoverDirect({
      source: "lever",
      company_slug: "acme"
    });
    assert.equal(result.postings[0].url, null);
  });

  it("constructs the correct URL", async () => {
    let capturedUrl = "";
    const stub: FetchImpl = (async (input: unknown) => {
      capturedUrl = String(input);
      return {
        ok: true,
        status: 200,
        async json() {
          return [];
        }
      } as unknown as Response;
    }) as FetchImpl;
    const c = leverConnector({ fetchImpl: stub });
    await c.discoverDirect({ source: "lever", company_slug: "acme" });
    assert.equal(
      capturedUrl,
      "https://api.lever.co/v0/postings/acme?mode=json"
    );
  });
});
