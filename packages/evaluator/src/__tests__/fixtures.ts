import type { ExtractedJobFacts } from "../extract/schema.js";

/**
 * Representative posting texts. These are hand-crafted, not real postings,
 * so they can live in the repo without licensing concerns.
 */
export const postingAnthropicResearchEngineer = `
Research Engineer, Agents
Anthropic · San Francisco, CA (hybrid) · Full-time

About the role
We're looking for a Research Engineer to join the Agents team, focused on
building evaluation harnesses for large-scale agent workflows. You will
design quantitative experiments, construct model benchmarks, and work on
synthetic data generation pipelines.

Minimum qualifications
- 5+ years of engineering experience
- Strong Python and systems-programming skills
- Experience with LLMs, RAG, or agent frameworks

Preferred
- Published research or open-source contributions
- Experience with evaluation and benchmarking at scale

Compensation: $250,000–$400,000 + equity.
`;

export const postingLockheedClearedRole = `
Software Engineer - Integrated Systems
Lockheed Martin · Denver, CO · Full-time · On-site

We are looking for a Software Engineer to support mission-critical defense
systems.

REQUIREMENTS:
- Bachelor's degree in CS or related
- 3+ years software engineering experience
- MUST have active security clearance required (Secret or higher)
- US Citizens only with active clearance
- C++, embedded systems experience preferred

This role is on-site 5 days a week in Denver, CO.
`;

export const postingStartupStaff = `
Staff Software Engineer, Platform
Acme Robotics · Remote (US)

Acme is hiring a Staff Engineer to own the platform team. You'll architect
distributed systems, mentor senior engineers, and set technical direction.

What we're looking for
- 10+ years of engineering experience, 3+ as a staff/principal IC
- Deep expertise in distributed systems
- Fluency in Go or Rust

Stack: Go, Rust, Kubernetes, AWS.

This is a fully remote role for candidates based in the United States.
`;

export const postingVagueIntern = `
Software Engineering Intern
Unnamed startup

We are looking for a summer software engineering intern. No specific
requirements listed. Please apply if interested.
`;

/**
 * Convenience builder for a fully-valid ExtractedJobFacts object with
 * sensible defaults. Tests spread overrides on top.
 */
export function baseValidFacts(
  overrides: Partial<ExtractedJobFacts> = {}
): ExtractedJobFacts {
  return {
    extractor_version: "extract_v1",
    title: "Software Engineer",
    company: "Acme",
    seniority_signals: ["mid"],
    required_clearance: null,
    required_yoe: { min: null, max: null },
    industry_tags: ["software"],
    required_onsite: { is_required: false, locations: [] },
    employment_type: "full_time",
    work_authorization_constraints: [],
    stack: [],
    raw_text_excerpt: "Software Engineer at Acme.",
    ...overrides
  };
}
