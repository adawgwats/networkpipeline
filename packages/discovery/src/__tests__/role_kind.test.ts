import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferRoleKindsFromTitle } from "../connector/role_kind.js";

/**
 * The classifier biases toward false positives. Tests assert MEMBERSHIP
 * (the expected kind is in the result) rather than equality, so adding
 * additional matches in the future doesn't break things. Per-tag groups
 * include 3 positive examples and at least 1 control.
 */
function has(title: string, kind: string): boolean {
  return inferRoleKindsFromTitle(title).includes(kind as never);
}

describe("inferRoleKindsFromTitle — engineering", () => {
  it("matches Software Engineer / Backend Engineer / SWE", () => {
    assert.ok(has("Software Engineer", "engineering"));
    assert.ok(has("Senior Backend Engineer", "engineering"));
    assert.ok(has("SWE II, Platform", "engineering"));
  });
  it("does NOT classify a Designer as engineering", () => {
    assert.ok(!has("Product Designer", "engineering"));
  });
});

describe("inferRoleKindsFromTitle — research", () => {
  it("matches Research Engineer / Research Scientist / Researcher", () => {
    assert.ok(has("Research Engineer, Agents", "research"));
    assert.ok(has("Research Scientist", "research"));
    assert.ok(has("AI Researcher", "research"));
  });
  it("does NOT classify a Sales Manager as research", () => {
    assert.ok(!has("Sales Manager", "research"));
  });
});

describe("inferRoleKindsFromTitle — ml", () => {
  it("matches ML Engineer / Applied ML Scientist / Data Scientist", () => {
    assert.ok(has("ML Engineer", "ml"));
    assert.ok(has("Applied AI Scientist", "ml"));
    assert.ok(has("Senior Data Scientist", "ml"));
  });
  it("does NOT classify a Sales Manager as ml", () => {
    assert.ok(!has("Sales Manager", "ml"));
  });
});

describe("inferRoleKindsFromTitle — infrastructure", () => {
  it("matches Infrastructure Engineer / Platform Engineer / SRE", () => {
    assert.ok(has("Infrastructure Engineer", "infrastructure"));
    assert.ok(has("Platform Engineer, Distributed Systems", "infrastructure"));
    assert.ok(has("SRE", "infrastructure"));
  });
  it("infrastructure also tags engineering", () => {
    assert.ok(has("Cloud Engineer", "engineering"));
  });
});

describe("inferRoleKindsFromTitle — security", () => {
  it("matches Security Engineer / AppSec Engineer / Product Security Researcher", () => {
    assert.ok(has("Security Engineer", "security"));
    assert.ok(has("AppSec Engineer", "security"));
    assert.ok(has("Product Security Researcher", "security"));
  });
  it("security tag co-occurs with engineering", () => {
    const kinds = inferRoleKindsFromTitle("Senior Security Engineer");
    assert.ok(kinds.includes("security"));
    assert.ok(kinds.includes("engineering"));
  });
  it("does NOT match unrelated 'security' words like 'Securities Trader'", () => {
    // Lone "security" without engineer/architect/researcher does not
    // trip the gate.
    assert.ok(!has("Securities Trader", "security"));
  });
});

describe("inferRoleKindsFromTitle — design", () => {
  it("matches Product Designer / UX Designer / Visual Designer", () => {
    assert.ok(has("Product Designer", "design"));
    assert.ok(has("Senior UX Designer", "design"));
    assert.ok(has("Visual Designer", "design"));
  });
  it("does NOT classify a Software Engineer as design", () => {
    assert.ok(!has("Software Engineer", "design"));
  });
});

describe("inferRoleKindsFromTitle — product", () => {
  it("matches Product Manager / TPM / Group Product Manager", () => {
    assert.ok(has("Product Manager, Growth", "product"));
    assert.ok(has("Technical Program Manager", "product"));
    assert.ok(has("Group Product Manager", "product"));
  });
  it("does NOT classify lone 'product' words like 'Product Designer' as product", () => {
    // Product Designer should be design, not product.
    const kinds = inferRoleKindsFromTitle("Product Designer");
    assert.ok(kinds.includes("design"));
    assert.ok(!kinds.includes("product"));
  });
});

describe("inferRoleKindsFromTitle — sales", () => {
  it("matches Account Executive / SDR / Sales Engineer / Solutions Engineer", () => {
    assert.ok(has("Account Executive, Enterprise", "sales"));
    assert.ok(has("Senior SDR", "sales"));
    assert.ok(has("Sales Engineer", "sales"));
  });
  it("Solutions Engineer is BOTH sales AND engineering", () => {
    const kinds = inferRoleKindsFromTitle("Solutions Engineer");
    assert.ok(kinds.includes("sales"));
    assert.ok(kinds.includes("engineering"));
  });
  it("does NOT classify a Software Engineer as sales", () => {
    assert.ok(!has("Software Engineer", "sales"));
  });
});

describe("inferRoleKindsFromTitle — customer_success", () => {
  it("matches Customer Success Manager / Onboarding / Implementation Specialist", () => {
    assert.ok(has("Customer Success Manager", "customer_success"));
    assert.ok(has("Onboarding Manager", "customer_success"));
    assert.ok(has("Implementation Specialist", "customer_success"));
  });
  it("does NOT classify a Sales Engineer as customer_success", () => {
    assert.ok(!has("Sales Engineer", "customer_success"));
  });
});

describe("inferRoleKindsFromTitle — marketing", () => {
  it("matches Marketing Manager / Growth Manager / Content Strategist", () => {
    assert.ok(has("Senior Marketing Manager", "marketing"));
    assert.ok(has("Growth Manager", "marketing"));
    assert.ok(has("Content Strategist", "marketing"));
  });
  it("does NOT classify a Software Engineer as marketing", () => {
    assert.ok(!has("Software Engineer", "marketing"));
  });
});

describe("inferRoleKindsFromTitle — recruiting", () => {
  it("matches Recruiter / Talent Acquisition / Sourcer", () => {
    assert.ok(has("Senior Recruiter", "recruiting"));
    assert.ok(has("Talent Acquisition Partner", "recruiting"));
    assert.ok(has("Technical Sourcer", "recruiting"));
  });
  it("does NOT classify a Customer Success Manager as recruiting", () => {
    assert.ok(!has("Customer Success Manager", "recruiting"));
  });
});

describe("inferRoleKindsFromTitle — people_ops", () => {
  it("matches People Operations / HRBP / People Partner", () => {
    assert.ok(has("People Operations Manager", "people_ops"));
    assert.ok(has("HRBP, Engineering", "people_ops"));
    assert.ok(has("Senior People Partner", "people_ops"));
  });
  it("does NOT classify a Software Engineer as people_ops", () => {
    assert.ok(!has("Software Engineer", "people_ops"));
  });
});

describe("inferRoleKindsFromTitle — finance", () => {
  it("matches Finance Manager / Accountant / Controller", () => {
    assert.ok(has("Finance Manager", "finance"));
    assert.ok(has("Senior Accountant", "finance"));
    assert.ok(has("Controller, FP&A", "finance"));
  });
  it("does NOT classify a Software Engineer as finance", () => {
    assert.ok(!has("Software Engineer", "finance"));
  });
});

describe("inferRoleKindsFromTitle — legal", () => {
  it("matches Counsel / Lawyer / Privacy Counsel / Paralegal", () => {
    assert.ok(has("Senior Counsel, Privacy", "legal"));
    assert.ok(has("Privacy Counsel", "legal"));
    assert.ok(has("Paralegal", "legal"));
  });
  it("does NOT classify a Sales Engineer as legal", () => {
    assert.ok(!has("Sales Engineer", "legal"));
  });
});

describe("inferRoleKindsFromTitle — operations", () => {
  it("matches BizOps / Chief of Staff / RevOps", () => {
    assert.ok(has("Senior BizOps Analyst", "operations"));
    assert.ok(has("Chief of Staff", "operations"));
    assert.ok(has("Revenue Operations Manager", "operations"));
  });
  it("does NOT classify a Software Engineer as operations", () => {
    assert.ok(!has("Software Engineer", "operations"));
  });
});

describe("inferRoleKindsFromTitle — support", () => {
  it("matches Technical Support Engineer / Customer Support / Help Desk", () => {
    assert.ok(has("Technical Support Engineer", "support"));
    assert.ok(has("Customer Support Engineer", "support"));
    assert.ok(has("Help Desk Specialist", "support"));
  });
  it("does NOT classify a Backend Engineer as support", () => {
    assert.ok(!has("Backend Engineer", "support"));
  });
});

describe("inferRoleKindsFromTitle — data", () => {
  it("matches Data Engineer / Analytics Engineer / Data Analyst", () => {
    assert.ok(has("Data Engineer", "data"));
    assert.ok(has("Analytics Engineer", "data"));
    assert.ok(has("Senior Data Analyst", "data"));
  });
  it("does NOT classify a Data Scientist as data (treated as ml)", () => {
    const kinds = inferRoleKindsFromTitle("Data Scientist");
    assert.ok(kinds.includes("ml"));
    assert.ok(!kinds.includes("data"));
  });
});

describe("inferRoleKindsFromTitle — devrel", () => {
  it("matches Developer Advocate / DevRel Engineer / Developer Experience", () => {
    assert.ok(has("Developer Advocate", "devrel"));
    assert.ok(has("DevRel Engineer", "devrel"));
    assert.ok(has("Developer Experience Lead", "devrel"));
  });
  it("does NOT classify a Backend Engineer as devrel", () => {
    assert.ok(!has("Backend Engineer", "devrel"));
  });
});

describe("inferRoleKindsFromTitle — policy", () => {
  it("matches Policy Manager / Trust & Safety / Public Affairs", () => {
    assert.ok(has("Senior Policy Manager", "policy"));
    assert.ok(has("Trust and Safety Lead", "policy"));
    assert.ok(has("Public Affairs Director", "policy"));
  });
  it("does NOT classify a Backend Engineer as policy", () => {
    assert.ok(!has("Backend Engineer", "policy"));
  });
});

describe("inferRoleKindsFromTitle — multi-tag titles", () => {
  it("Senior Security Engineer tags engineering AND security", () => {
    const kinds = inferRoleKindsFromTitle("Senior Security Engineer");
    assert.ok(kinds.includes("engineering"));
    assert.ok(kinds.includes("security"));
  });
  it("Solutions Engineer tags engineering AND sales", () => {
    const kinds = inferRoleKindsFromTitle("Solutions Engineer");
    assert.ok(kinds.includes("engineering"));
    assert.ok(kinds.includes("sales"));
  });
  it("Data Engineer tags data AND engineering", () => {
    const kinds = inferRoleKindsFromTitle("Data Engineer");
    assert.ok(kinds.includes("data"));
    assert.ok(kinds.includes("engineering"));
  });
});

describe("inferRoleKindsFromTitle — 'other' fallback", () => {
  it("returns ['other'] for empty title", () => {
    assert.deepEqual(inferRoleKindsFromTitle(""), ["other"]);
  });
  it("returns ['other'] for purely whitespace title", () => {
    assert.deepEqual(inferRoleKindsFromTitle("   "), ["other"]);
  });
  it("returns ['other'] for unrecognized job title", () => {
    assert.deepEqual(inferRoleKindsFromTitle("Cosmic Ray Whisperer"), [
      "other"
    ]);
  });
  it("returns ['other'] when no kind regex matches", () => {
    // "Janitor" doesn't match any tag.
    assert.deepEqual(inferRoleKindsFromTitle("Janitor"), ["other"]);
  });
});

describe("inferRoleKindsFromTitle — case insensitivity & dedup", () => {
  it("classifies regardless of letter case", () => {
    assert.ok(inferRoleKindsFromTitle("SOFTWARE ENGINEER").includes("engineering"));
    assert.ok(inferRoleKindsFromTitle("software engineer").includes("engineering"));
  });
  it("dedupes when multiple regex blocks match the same kind", () => {
    // "Software Engineer" matches engineering via two paths; should
    // appear only once in the output.
    const kinds = inferRoleKindsFromTitle("Senior Software Engineer");
    const engCount = kinds.filter((k) => k === "engineering").length;
    assert.equal(engCount, 1);
  });
});

describe("inferRoleKindsFromTitle — Anthropic Greenhouse exemplars", () => {
  // Real titles from the Anthropic board (paraphrased) that the
  // user's blocklist should reject pre-extraction.
  it("'Account Executive, Startups, EMEA' tags sales", () => {
    assert.ok(
      inferRoleKindsFromTitle("Account Executive, Startups, EMEA").includes(
        "sales"
      )
    );
  });
  it("'Senior Recruiter, Engineering' tags recruiting", () => {
    assert.ok(
      inferRoleKindsFromTitle("Senior Recruiter, Engineering").includes(
        "recruiting"
      )
    );
  });
  it("'Customer Success Engineer' tags customer_success", () => {
    assert.ok(
      inferRoleKindsFromTitle("Customer Success Engineer").includes(
        "customer_success"
      )
    );
  });
  it("'Privacy Counsel' tags legal", () => {
    assert.ok(inferRoleKindsFromTitle("Privacy Counsel").includes("legal"));
  });
  it("'Senior Policy Manager, Public Sector' tags policy", () => {
    assert.ok(
      inferRoleKindsFromTitle("Senior Policy Manager, Public Sector").includes(
        "policy"
      )
    );
  });
  it("'Research Engineer, Agents' tags research AND engineering", () => {
    const kinds = inferRoleKindsFromTitle("Research Engineer, Agents");
    assert.ok(kinds.includes("research"));
    assert.ok(kinds.includes("engineering"));
  });
});
