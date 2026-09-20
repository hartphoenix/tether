# Tether operational-cost study

Reviewed 2026-09-20 against `04dc6b7`. This delegated study examines local Codex logs and current CLI code; it is not a runtime-performance or billing benchmark. Sanitized measurements: [aggregate JSON](tether-operational-cost-study-2026-09-20.aggregate.json).

## Assessment

The latest CLI already makes routine registration cheap. In this sample, document loading, command discovery, and recovery contributed substantially more material than registration receipts. Preserve progressive reads and retry safety; improve focused error guidance and validate recovery. The evidence does not justify a new combined review API, MCP migration, or automatic acknowledgement.

## Cutoff and sample

Git identifies two relevant updates:

- `673f9c3`, 2026-09-14 13:42:35 UTC: the latest substantive agent-workflow change, including compact registration results, preserved failure evidence, partial outcomes, and reporting guidance.
- `e87f2ca`, 2026-09-16 18:09:41 UTC: the latest change under `src/cli`, replacing exact cmux version/build matching with minimum-version compatibility. It did not redesign review results.

Use the first cutoff to evaluate the workflow revision, and report the second as a narrower cohort. The scan examined 392 local session JSONL files, matched timestamped calls after the first cutoff, and deduplicated inherited tool calls by call ID. Six distinct sessions contained detectable CLI use; three had use after the second cutoff. This is a convenience sample of one user's available logs, not a representative population or randomized experiment.

| Sample | Matched dates | Task context | Detected CLI-containing outer calls |
| --- | --- | --- | ---: |
| S01 | Sep 15 | Security-audit revision/review | 6 |
| S02 | Sep 15–20 | Research documents and review outside Tether development | 15 |
| S03 | Sep 15–16 | Tether geometry implementation and document registration | 8 |
| S04 | Sep 16 | Host compatibility and comment review | 12 |
| S05 | Sep 16–20 | Host-resume audit and implementation | 6 |
| S06 | Sep 20 | Security-audit revision and the preceding review loop | 6 |

There are 53 detected CLI-containing outer calls, including 13 after the latest literal CLI commit. An outer call may execute several commands, loops, parallel commands, or unrelated tools. It is not a CLI invocation count or an exact sequential-round-trip count. Shell loops and truncated/missing outputs prevent a complete invocation census.

Session-start Git metadata is not runtime provenance: several sessions began before the cutoff or in another repository while invoking the shared checkout. Pre-cutoff calls are excluded. Recoverable registration successes have the compact `added` result, supporting use of the updated result code; timestamps alone cannot prove the version of every daemon-backed response. No per-call build identity was available. The present study request and its subsequent activity are excluded, while earlier completed work in S06 remains in the sample. Exclusion begins at the first user-message event containing the explicit operational-cost study request; the operational-study agent path is also excluded. Its exact timestamp was not retained in the aggregate, so the exclusion is specified by event boundary. No matched pre-update cohort was collected; this study establishes no causal before/after savings.

## What was measured

Parsing examined only tool-call/result structure and numeric usage fields. No raw transcript excerpts, private review bodies, log paths, or authentication material are retained here. The parser recognized literal and template `exec_command` inputs and nested result wrappers; it did not execute logged code. Findings are extraction lower bounds, with manual structural checks on the latest review loop.

Three quantities must remain separate:

1. **CLI envelope size:** UTF-8 bytes of recovered protocol objects, reserialized as compact JSON. This normalizes formatting; it is not an exact tokenizer count or necessarily the original stdout byte count.
2. **Log-visible batch size:** UTF-8 text of outer tool results, including shell wrappers and any other command output. This measures material available in the log, not Tether-only traffic; truncation can hide source output.
3. **Provider counters:** differences between available `token_count` cumulative observations over each sampled session window. These cover all work in that window and cannot assign marginal token cost to Tether.

| Measurement | Observed |
| --- | ---: |
| Recovered CLI protocol envelopes | 84; 71,603 compact JSON bytes |
| CLI-containing outer-result text | 368,020 bytes |
| Other matched Markdown-read batches in those sessions | 1,235,278 bytes |
| Extracted shell command text in CLI-containing calls | 40,129 bytes |
| Successful registration receipt | 123–167 bytes |
| Successful pending result | 2,317–12,429 bytes |
| Recovered thread result | 421–4,429 bytes |
| Reply result | 572–584 bytes |
| Acknowledgement result | 497–522 bytes |

The first row is a recoverable payload subset. The next two rows include unrelated task material and must not be summed into a claimed Tether bill. Some envelopes are unrecoverable after truncation or output filtering. Repeated identical envelopes inside one output are counted once.

For rough scale only, dividing bytes by four gives about 17,901 token-equivalents for recovered envelopes, 92,005 for CLI-containing batches, and 308,820 for other read batches. These are uncalibrated estimates: JSON punctuation, paths, Unicode, whitespace, and the harness's rendering change tokenization. They are not measured model input, billed tokens, or projected savings.

Actual whole-window counter deltas were:

| Sample | Input tokens | Cached input tokens | Output tokens |
| --- | ---: | ---: | ---: |
| S01 | 1,847,197 | 1,761,024 | 8,444 |
| S02 | 6,990,541 | 6,006,400 | 22,197 |
| S03 | 30,095,805 | 29,528,576 | 102,235 |
| S04 | 20,903,856 | 20,529,280 | 51,214 |
| S05 | 12,294,311 | 11,952,384 | 37,072 |
| S06 | 1,756,380 | 1,569,664 | 7,610 |

The exact counter windows are below; they span all session activity between observations, not just CLI calls.

| Sample | First observation (UTC) | Last observation (UTC) |
| --- | --- | --- |
| S01 | 2026-09-14T13:42:36.942Z | 2026-09-16T14:24:07.139Z |
| S02 | 2026-09-15T15:31:09.286Z | 2026-09-20T18:37:58.438Z |
| S03 | 2026-09-15T22:31:36.839Z | 2026-09-16T14:45:12.912Z |
| S04 | 2026-09-16T15:30:40.109Z | 2026-09-16T18:10:20.739Z |
| S05 | 2026-09-16T18:14:35.495Z | 2026-09-20T18:09:45.028Z |
| S06 | 2026-09-20T18:17:22.082Z | 2026-09-20T19:28:51.411Z |

All endpoint differences are nonnegative. Intermediate counter resets, compaction effects, and inherited/fork counter accounting were not independently reconciled; their impact is unavailable from this extraction. Tool-call deduplication does not establish counter independence, so these rows must not be summed into an account-wide or task-specific total.

These are observed cumulative-counter differences, excluding the first observed request in each window; they are not complete task totals. Cached input accounts for 85.9–98.2% of these input deltas. That does not establish that any particular Tether result hit cache. Repeated accumulated context explains why request-input activity can greatly exceed fresh material. No dollar, credit, or subscription-capacity attribution is supported. See the [[references/provider-cache-behavior.md|cache reference]] for the distinction between incremental context and harness-dependent caching.

## Where the cost arose

**Reading and discovery.** No `document read` call was detected. Agents instead used shell reads, often batching README, product-plan, audits, and source inspection. The parser found 57 full-read syntax sites and 38 bounded/search sites across matched batches; these are syntactic counts, not verified complete-document deliveries. Repeated batches commonly approached 30–40 KB and sometimes truncated, requiring another read. Document formatting and mixed source output contribute to size, so the totals do not establish that every reread was unnecessary. Cold-start repository instructions also require README and plan reads: that is an instruction/design cost, not a CLI defect.

**Review round trips.** The latest completed S06 review used five outer exchanges: pending; four parallel threads plus help/context inspection; a body save; two replies; acknowledgement plus registration. The 11 recovered envelopes total 9,212 bytes. Pending was 3,355 bytes, the four thread results totaled 2,608 bytes, and exact repeated review-body text between pending and those thread responses accounted for only 92 bytes. Threads also supply current state and earlier dialogue. Removing them indiscriminately would trade useful correctness information for a small observed duplication reduction.

**Command input.** CLI-containing shell inputs totaled roughly 40 KB, but include authored documents, reply text, shell glue, and unrelated work. Two S03 batches used 9,151 and 5,834 input bytes while returning 144-byte registration receipts: document-authoring scripts dominated those inputs. S06 generated a 2,343-byte save script and received a 347-byte receipt. Authored content is task work; it is not removable protocol overhead. The sample does not support a separate estimate of avoidable generated tokens.

**Failures and recovery.** Three explicit failed envelopes were recovered: two `daemon_unreachable` responses in S01 and one `usage` error for `document context` in S04. The pending reachability failure was followed by a successful retry; a registration retry initially yielded a running tool rather than a final result, so no failure rate or latency estimate is defensible. The context usage failure led to focused help and then a successful corrected request—an observed avoidable discovery exchange. S04 also requested a diff whose baseline was unavailable and received a bounded fallback, then used local context. That is correct recovery behavior, not evidence that full-document fallback or persistent history is necessary.

## Recommended next-pass changes

1. **Add command-focused guidance to usage errors.** In `src/cli/main.ts` and `src/cli/commands.ts`, use the already parsed command specification to return a bounded usage/example or help target with the existing error. Preserve exit codes, diagnostics, and stable error fields. Validate the observed invalid-context case: an agent should be able to correct it without a separate help call. Do not append the whole command catalogue to every response.
2. **Keep existing compact successes and bounded recovery.** `src/cli/results.ts` already removes routine registry/host bookkeeping. Retain `pending → thread → context/outline/diff` and the unavailable-revision fallback. This sample provides insufficient evidence for a combined packet or changed pagination, cursor, receipt, or acknowledgement semantics.
3. **Reduce broad rereading through guidance and task-sized verification.** Prefer focused command help and bounded document context once the artifact is known. Avoid rereading entire manuals after a narrow error. Repository/installed-agent instruction changes require Hart's approval; propose them separately rather than silently changing persistent context. Full reads remain appropriate for a whole-document audit or cold recovery.
4. **Treat host recovery as operational-cost work.** The observed reachability errors support testing explicit recovery outcomes and retry guidance alongside the security/Wave work. They do not establish that Wave caused these failures. Preserve uncertainty about partially applied mutations; fewer tool calls must not mean blind retries or weaker authentication.
5. **Use a small synthetic replay before further CLI redesign.** Reproduce registration, the five-exchange review, invalid-context correction, unavailable diff, daemon loss, and a large-document cold start. Compare command bytes, actual stdout bytes, sequential exchanges, completion correctness, and output truncation against this baseline. No private-log fixture is necessary. Add larger protocol changes only if this controlled comparison exposes a material deficit.

No CPU, memory, battery, idle polling, exact CLI wall latency, or human-attention duration was measured. Those remain separate empirical questions; this study establishes context and recovery costs, not a complete operating-expense model.
