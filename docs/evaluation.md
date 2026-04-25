# Evaluation Harness

## Status

Status: `proposed`

This document specifies how NetworkPipeline measures itself. The harness is the single most important artifact in the repo — it turns the project from "nice CRM" into "small research artifact" and is what makes the work defensible to frontier-lab hiring.

## 1. Framing: We Are Not Training Models

NetworkPipeline uses Claude at inference time. Every dataset referenced here is used as one of three things:

- `Test fixtures` — inputs with known correct outputs, used as regression tests
- `Calibration anchors` — few-shot examples injected into prompts
- `Voice exemplars` — real writing samples we compare our drafts against statistically

No dataset is used for model training. This framing determines everything below.

## 2. The Three Layers

The harness is structured in three layers with increasing fidelity and decreasing availability.

### 2.1 Layer 1 — Public-Dataset Seed Tests

Run in CI on every PR. Uses committed, pseudonymized samples from public datasets.

Purpose:

- Catch regressions on extraction, gating, voice drift, path ranking
- Provide a baseline that exists from day one
- Give the project a credible public ablation table at V1 ship

### 2.2 Layer 2 — Synthetic Adversarial Cases

Run nightly. LLM-generated edge cases targeting each gate, values refusal, and guardrail.

Purpose:

- Cover cases public data cannot provide (there is no public dataset labelling jobs as "ethically objectionable")
- Probe gate ordering and short-circuit behavior
- Exercise the active-learning loop in a controlled environment

Generated seeds are deterministic so runs are reproducible.

### 2.3 Layer 3 — Dogfood Ground Truth

Opt-in. Derived from the maintainer's (and later, users') own Gmail, Calendar, and thumbs-up/down history.

Purpose:

- Highest-fidelity feedback on the actual product outcomes
- Real reply labels on real outreach
- Voice calibration to the actual user
- Inputs to the active-learning loop

Never required for V1 correctness; supplements Layers 1 and 2.

## 3. Metrics

### 3.1 Filter

| Metric | Definition | Primary data source |
|---|---|---|
| `gate_determinism` | Same posting → same gate verdict across runs | Layer 1 (xanderios/linkedin-job-postings) |
| `gate_latency_p95` | 95th percentile latency of hard_gate_check | Layer 1 |
| `extraction_agreement` | Agreement between current extractor and frozen truth labels | Layer 1 |
| `soft_score_correlation` | Spearman correlation with resume-JD-fit labels | cnamuangtoun/resume-job-description-fit |
| `filter_precision` | Of PASSed jobs, fraction with positive user signal | Layer 3 thumbs |
| `filter_recall` | Of user-accepted jobs, fraction filter also PASSed | Layer 3 thumbs |
| `values_violation_detection_rate` | Recall on synthetic values-violation test cases | Layer 2 |

### 3.2 Intro Path Engine

| Metric | Definition | Primary data source |
|---|---|---|
| `bfs_correctness` | Shortest-path agreement with NetworkX reference | SNAP email-Enron |
| `ranking_spec_compliance` | Ranking matches documented weight ordering on synthetic scenarios | Layer 2 |
| `path_top1_pursued` | Of top-1 paths shown, fraction user pursued | Layer 3 |
| `bridge_committed_rate` | Of bridge-asks sent, fraction got commitment | Layer 3 |
| `committed_to_intro_made_rate` | Of committed bridges, fraction actually introduced | Layer 3 |
| `intro_made_to_conversation_rate` | Of intros made, fraction led to target conversation | Layer 3 |

### 3.3 Outreach Drafts

| Metric | Definition | Primary data source |
|---|---|---|
| `voice_distance` | L2 distance between draft and reply-getting Enron voice vector | Enron-derived |
| `banned_phrase_rate` | Frequency of known-bad phrases per draft | Enron-derived baseline + drafts |
| `length_in_target_band` | Fraction of drafts within per-intent length target | Enron-derived |
| `target_reply_rate` | Of sent target messages, fraction replied | Layer 3 |
| `bridge_reply_rate` | Of sent bridge-asks, fraction replied | Layer 3 |
| `edit_distance_to_approved` | Mean Levenshtein between draft and user-approved final | Layer 3 |

### 3.4 Cost And Operations

| Metric | Definition | Primary data source |
|---|---|---|
| `prompt_cache_hit_ratio` | cache_read_tokens / (cache_read + cache_creation) per tool | provider_runs |
| `cost_per_approved_draft` | Total USD / count of approved drafts | provider_runs |
| `cost_per_evaluation` | Total USD / count of evaluations | provider_runs |
| `throughput_10k_eval` | Wall-clock time to evaluate 10k postings | Layer 1 bulk |

## 4. Public Datasets

### 4.1 Filter Corpora

`xanderios/linkedin-job-postings` (HuggingFace) — primary job-posting test corpus.

Usage:

- Committed sample: 2,000 postings in `tests/fixtures/eval/jobs/linkedin-2k/`
- Deterministic sampling script: `scripts/build-eval-fixtures.ts --seed=42 --n=2000`
- Drives: `gate_determinism`, `extraction_agreement`, `gate_latency_p95`
- Full-scale runs (10k, 50k) available via `npm run eval:bulk --dataset=xanderios-linkedin --n=N`

`cnamuangtoun/resume-job-description-fit` (HuggingFace) — resume-JD fit-labeled pairs.

Usage:

- Drives `soft_score_correlation` metric
- Provides calibration-ablation ground truth (with vs without external calibration)
- Committed sample: 500 stratified pairs

`will4381/job-posting-classification` (HuggingFace) — weak-labeled classifications.

Usage:

- Cross-model sanity check on industry-tag extraction
- Seeds the initial `industry_tags` controlled vocabulary
- NOT treated as ground truth — labels are LLM-generated and weak

`asaniczka/1.3M LinkedIn Jobs & Skills (2024)` (Kaggle) — scale testing only.

Usage:

- Quarterly scale runs, not in CI
- Stress tests: memory bound, cache hit stability, cost linearity
- Never committed; pulled via script

`lang-uk/recruitment-dataset-job-descriptions-english` (HuggingFace) — richer-schema jobs.

Usage:

- Cross-check extraction against the dataset's structured fields (experience requirements, keywords)

### 4.2 Email Corpora

`Enron Corpus` (Kaggle + Cornell copies; public, unrestricted).

Usage:

- Source for voice exemplars and guardrail baselines
- Derived dataset `enron_warm_outreach_exemplars_v1` produced by `scripts/build-enron-exemplars.ts`:
  - Filter: first-message threads, < 200 words, single recipient, not RE/FWD, not system-generated
  - Tag: `got_reply_within_7d`, `no_reply`, `thread_continued`
  - Pseudonymize names and dates, preserve voice/structure
- Drives: `voice_distance`, `banned_phrase_rate`, `length_in_target_band`

`Avocado Research Email Collection` (LDC LDC2015T03).

Usage:

- Deferred to V2 (LDC license agreements are procedural overhead)
- When available: second voice corpus for modern tech-industry register

`EmailSum` (GitHub ZhangShiyue/EmailSum).

Usage:

- Deferred. Useful when we need to test thread summarization behavior.

### 4.3 Graph Corpora

`SNAP email-Enron network` (snap.stanford.edu/data/email-Enron.html).

Usage:

- 36K nodes, 184K edges undirected email graph
- Drives: `bfs_correctness` (vs NetworkX reference), `ranking_spec_compliance`, warmth-decay replication
- Pure algorithm tests — no LLM, no NetworkPipeline domain logic

## 5. Per-Dataset Usage Plans

### 5.1 xanderios/linkedin-job-postings

**Test 1: Gate determinism**

```
For each of 2,000 sampled postings:
  Run extract_job_facts
  Run hard_gate_check against andrew-v1.yaml + 3 other criteria variants
  Assert: same posting + same criteria → identical verdict across 5 runs
  Assert: hard_gate_check latency < 50ms per call
Fails CI on any nondeterminism or latency breach.
```

**Test 2: Extraction drift**

```
One-time setup:
  Run extract_job_facts on all 2,000 postings with a frozen extractor version
  Commit outputs as tests/fixtures/eval/jobs/linkedin-2k/extractor-v1.jsonl

On every PR:
  Run current extractor on 200 random posts from the frozen set
  Measure field-level agreement against frozen outputs
  Fail CI if overall agreement < 95%
```

**Test 3: Throughput**

```
npm run eval:bulk --n=10000 completes in < 15 min on a laptop with cache on
Track cost per evaluation; alert if cost rises > 2× baseline
```

### 5.2 cnamuangtoun/resume-job-description-fit

**Test 1: Soft-score correlation**

```
Take 500 stratified pairs (by fit label)
Run soft_score(jd, andrew-v1.yaml) for each
Spearman correlation between our score and their fit label
Assert: correlation > 0.4 (monotonic relationship)
Fails CI if correlation drops > 0.1 vs baseline
```

**Test 2: Calibration ablation**

```
Run the same 500 pairs in three configurations:
  A: soft_score with full calibration examples
  B: soft_score with no calibration examples
  C: soft_score with dataset-derived calibration
Report: correlation delta A-B, A-C
Expected: A > B (calibration helps)
If A < B, investigate prompt contamination
```

### 5.3 Enron → warm outreach exemplar pool

**One-time derivation** (`scripts/build-enron-exemplars.ts`):

```
Input: raw Enron Corpus
Filter threads where:
  - len(participants) <= 3
  - first message subject does not start with RE: FWD: AUTO:
  - first message body 20-400 words
  - no attachments
  - sender != recipient
Tag each:
  - got_reply_within_7d: bool
  - thread_length: int
  - response_time_hours: float
Pseudonymize:
  - replace real names with consistent pseudonyms (stable per-thread)
  - shift dates by per-thread random offset
Output: tests/fixtures/eval/outreach/enron-exemplars-v1.jsonl (~5-10k threads)
Compute pool statistics:
  - got-reply distribution over: sentence-length, word-count, pronoun-freq, question-count, closing-type
  - no-reply distribution over same metrics
Write: tests/fixtures/eval/outreach/enron-stats-v1.json
```

**Test 1: Voice distance**

```
For 50 synthetic (path, intent) test cases:
  Run draft_bridge_message
  Compute the draft's statistical vector: [word_count, avg_sentence_len, 
    pronoun_freq, question_count, first_person_ratio, hedging_freq]
  Compare against got-reply mean vector from enron-stats-v1
  Assert: L2 distance within 1.5 standard deviations
Fails CI if mean distance across test cases rises > 20% vs baseline
```

**Test 2: Banned phrase regression**

```
Extract phrase frequencies from Enron got-reply pool:
  - "huge fan": 0.3% of messages
  - "pick your brain": 0.1%
  - "quick chat": 0.4%
  - "circle back": 0.2%
  - "touch base": 0.3%
For 100 drafts generated by draft_bridge_message + draft_target_message:
  Assert: banned-phrase rate <= Enron baseline rate
Fails CI on rate exceeding baseline
```

**Test 3: Length calibration**

```
Enron got-reply first-messages: median 82 words, p90 174 words
For each intent, assert drafts fall in the empirical band:
  bridge_ask: 60-120 words
  cold_outreach: 80-160 words
  post_intro_followup: 50-120 words
```

### 5.4 SNAP email-Enron → path algorithm tests

**Test 1: BFS correctness**

```
Load the 36K-node email graph
For 1,000 random (source, target) pairs:
  Our find_intro_paths(source, target_via_synthetic_company)
  NetworkX nx.shortest_path_length(source, target)
  Assert: hop count matches
Fails CI on any mismatch
```

**Test 2: Ranking spec compliance**

```
Construct synthetic scenario on Enron graph:
  Source S, candidates T1 T2 T3 all at path length 2
  Assign synthetic warmth: S->A1 (high), S->A2 (low) 
  Assign synthetic edge strength: A1->T1 (high), A2->T2 (medium), A3->T3 (low)
Assert ranking: T1 > T2 > T3 (warmth × edge × relevance)
Assert path_length_penalty works: 3-hop strong bridge vs 1-hop weak
```

**Test 3: Warmth decay replication** (stretch)

```
Using Enron's real timestamped edges, fit an exponential decay to
interaction-recency vs reply-probability.
Assert our default recency_score function produces similar decay shape.
```

## 6. Synthetic Adversarial Cases (Layer 2)

Generated once per release via `scripts/generate-synthetic-adversarial.ts --seed=42`.

Coverage:

- Every hard gate: one positive and one negative case
- Every values refusal in the default template set: obvious violation, ambiguous case, clear pass
- Gate ordering: constructed cases where ordering matters (e.g., a posting that would be rejected by a later gate if an earlier one didn't fire first)
- Outreach guardrails: LLM prompted to produce drafts that sound natural but contain banned phrases; verify filter catches them

Stored in `tests/fixtures/eval/synthetic/v1/` with generation seed committed.

## 7. Dogfood Ground Truth (Layer 3)

Available once real usage accumulates. Drives:

- `filter_precision` and `filter_recall`
- `path_top1_pursued`
- `bridge_committed_rate`, `committed_to_intro_made_rate`, `intro_made_to_conversation_rate`
- `target_reply_rate`, `bridge_reply_rate`
- `edit_distance_to_approved`

Collection mechanisms:

- `log_outcome(thread_id, outcome)` on every reply / non-reply
- `mark_bridge_ask_outcome` at every lifecycle transition
- Thumbs-up / thumbs-down on evaluations triggers `propose_criteria_change`
- Optional: opt-in `ingest_gmail_history_for_eval` one-time import of past outreach with known reply outcomes

V1 dogfood: maintainer's own usage, committed as `docs/evaluation/snapshots/{date}.md` with N disclosed.

## 8. Ablation Matrix

Target ablation table for the V1 snapshot. Run via `npm run eval:ablation --config=<name>`.

| Configuration | gate_determinism | extraction_agreement | soft_correlation | voice_distance | bfs_correctness | cost_per_eval |
|---|---|---|---|---|---|---|
| `full` | — | — | — | — | — | — |
| `no-calibration` | — | — | — | n/a | n/a | — |
| `no-values-refusals` | — | — | n/a | n/a | n/a | — |
| `gates-only` | — | n/a | n/a | n/a | n/a | — |
| `no-warmth` | n/a | n/a | n/a | n/a | — | n/a |
| `no-edge-inference` | n/a | n/a | n/a | n/a | — | n/a |
| `no-enron-guardrails` | n/a | n/a | n/a | — | n/a | n/a |
| `cache-off` | — | — | — | — | n/a | — |

This table, populated in `docs/evaluation/snapshots/` over time, is the headline artifact for external readers.

## 9. Published Snapshots

Location: `docs/evaluation/snapshots/YYYY-MM-DD.md`

Template:

```markdown
# Evaluation Snapshot — YYYY-MM-DD

## Configuration
- Criteria version: N
- Commit: <hash>
- Dataset sample sizes: { filter_corpus: 2000, enron_exemplars: 5000, ... }
- Claude model: claude-opus-4-7 (+ cache)

## Layer 1 (public)
[ablation table rows]

## Layer 2 (synthetic)
[synthetic coverage table]

## Layer 3 (dogfood)
N=<count>
[user-usage metrics]

## Observations
[narrative]

## Open Questions
[unresolved items]
```

## 10. V2+ Extensions

Reserved but deferred:

- Multi-provider comparison (Claude vs GPT vs local): re-runs the full Layer 1 table across providers
- Avocado corpus integration for second voice register
- Automated longitudinal tracking: snapshots generated on a schedule
- User-segment analysis: do metrics differ across criteria template profiles?

## 11. Licensing And Privacy

- Every dataset gets an entry in `THIRD_PARTY_LICENSES.md` with source, license, citation, and usage notes.
- Enron samples in the repo are pseudonymized (stable per-thread name mapping + date shifts) before commit.
- Committed fixtures total < 50 MB. Larger samples regenerate deterministically from seed.
- No dataset is used to train any model. Citation as test fixtures only.
- Sources:
  - [xanderios/linkedin-job-postings](https://huggingface.co/datasets/xanderios/linkedin-job-postings)
  - [will4381/job-posting-classification](https://huggingface.co/datasets/will4381/job-posting-classification)
  - [asaniczka 1.3M LinkedIn Jobs & Skills 2024](https://www.kaggle.com/datasets/asaniczka/1-3m-linkedin-jobs-and-skills-2024)
  - [lang-uk/recruitment-dataset-job-descriptions-english](https://huggingface.co/datasets/lang-uk/recruitment-dataset-job-descriptions-english)
  - [cnamuangtoun/resume-job-description-fit](https://huggingface.co/datasets/cnamuangtoun/resume-job-description-fit)
  - [Enron Email Dataset (Kaggle)](https://www.kaggle.com/datasets/wcukierski/enron-email-dataset)
  - [SNAP email-Enron](https://snap.stanford.edu/data/email-Enron.html)

## 12. Related Docs

- [Criteria System](./criteria.md)
- [Intro Path Engine](./intro-paths.md)
- [Architecture](./architecture.md)
