import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ashbyConnector } from "../connectors/ashby.js";
import type { FetchImpl } from "../connector/types.js";

function mockFetch(response: {
  ok?: boolean;
  status?: number;
  json?: unknown;
  throwError?: Error;
}): FetchImpl {
  return (async (_input: unknown, _init?: unknown) => {
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
      id: "ashby-job-1",
      title: "Senior Backend Engineer",
      location: "San Francisco, CA",
      department: "Engineering",
      team: "Platform",
      employmentType: "FullTime",
      isRemote: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/ashby-job-1",
      applyUrl: "https://jobs.ashbyhq.com/acme/ashby-job-1/apply",
      descriptionHtml: "<p>Senior role.</p>",
      descriptionPlain: "Senior role."
    },
    {
      id: "ashby-job-2",
      title: "Staff Engineer (Intern Program)",
      location: "New York, NY",
      employmentType: "Intern",
      isRemote: true,
      jobUrl: "https://jobs.ashbyhq.com/acme/ashby-job-2",
      descriptionPlain: "Remote OK."
    },
    {
      id: "ashby-job-3",
      title: "Engineer",
      employmentType: "Contract",
      isRemote: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/ashby-job-3"
    }
  ]
};

describe("ashbyConnector", () => {
  it("identifies as 'ashby' direct connector", () => {
    const c = ashbyConnector();
    assert.equal(c.id(), "ashby");
    assert.equal(c.kind, "direct");
  });

  it("issues a POST with includeCompensation body", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl = "";
    const stub: FetchImpl = (async (input: unknown, init?: unknown) => {
      capturedUrl = String(input);
      capturedInit = init as RequestInit;
      return {
        ok: true,
        status: 200,
        async json() {
          return { jobs: [] };
        }
      } as unknown as Response;
    }) as FetchImpl;
    const c = ashbyConnector({ fetchImpl: stub });
    await c.discoverDirect({ source: "ashby", org_slug: "acme" });
    assert.equal(
      capturedUrl,
      "https://api.ashbyhq.com/posting-api/job-board/acme"
    );
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      includeCompensation: true
    });
  });

  it("normalizes a typical Ashby response", async () => {
    const c = ashbyConnector({
      fetchImpl: mockFetch({ json: FIXTURE_RESPONSE })
    });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "acme"
    });
    assert.equal(result.errors.length, 0);
    assert.equal(result.postings.length, 3);

    const a = result.postings[0];
    assert.equal(a.source, "ashby");
    assert.equal(a.external_ref, "ashby-job-1");
    assert.equal(a.title, "Senior Backend Engineer");
    assert.equal(a.company, "acme");
    assert.equal(a.url, "https://jobs.ashbyhq.com/acme/ashby-job-1");
    assert.deepEqual(a.onsite_locations, ["San Francisco, CA"]);
    assert.equal(a.is_onsite_required, true);
    assert.equal(a.employment_type, "full_time");
    assert.deepEqual(a.inferred_seniority_signals, ["senior"]);
    assert.equal(a.description_excerpt, "Senior role.");

    const b = result.postings[1];
    assert.equal(b.is_onsite_required, false);
    assert.deepEqual(b.onsite_locations, []);
    assert.equal(b.employment_type, "internship");
    assert.deepEqual(
      b.inferred_seniority_signals.sort(),
      ["intern", "staff"].sort()
    );

    const c3 = result.postings[2];
    assert.equal(c3.employment_type, "contract");
    assert.equal(c3.is_onsite_required, true); // isRemote=false, location empty -> still required
  });

  it("returns empty postings + error on HTTP error", async () => {
    const c = ashbyConnector({
      fetchImpl: mockFetch({ ok: false, status: 503 })
    });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("returns empty postings + error on malformed payload", async () => {
    const c = ashbyConnector({
      fetchImpl: mockFetch({ json: { not_jobs: [] } })
    });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /malformed/);
  });

  it("returns empty postings + error on network exception", async () => {
    const c = ashbyConnector({
      fetchImpl: mockFetch({ throwError: new Error("oops") })
    });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "x"
    });
    assert.equal(result.postings.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it("falls back to descriptionHtml when descriptionPlain is missing", async () => {
    const payload = {
      jobs: [
        {
          id: "x",
          title: "Engineer",
          descriptionHtml: "<p>Hello &amp; <em>welcome</em></p>",
          isRemote: false,
          jobUrl: "https://example.com/x"
        }
      ]
    };
    const c = ashbyConnector({ fetchImpl: mockFetch({ json: payload }) });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "acme"
    });
    assert.equal(result.postings[0].description_excerpt, "Hello & welcome");
  });

  it("maps unknown employmentType to null", async () => {
    const payload = {
      jobs: [
        {
          id: "x",
          title: "Engineer",
          employmentType: "PartTime",
          isRemote: false,
          jobUrl: "https://example.com/x"
        }
      ]
    };
    const c = ashbyConnector({ fetchImpl: mockFetch({ json: payload }) });
    const result = await c.discoverDirect({
      source: "ashby",
      org_slug: "acme"
    });
    assert.equal(result.postings[0].employment_type, null);
  });
});
