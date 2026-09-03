# Tether cache-fidelity audit

**Date:** 2026-09-01
**Scope:** current `phase-2-standalone-daemon` implementation, current Tether review records, Codex and Claude Code behavior, and current OpenAI, Anthropic, Google, and Amazon Bedrock caching documentation

## Executive assessment

Tether is directionally right, but its strongest current property is more precise than its original cache-invalidation rationale.

Tether does not directly preserve a provider cache when a user edits a file on disk. In Codex and Claude Code, a disk edit does not retroactively alter the conversation prefix in the first place. The old file read remains in history. If the agent reads the changed file again, that second read is appended as new tool output: the earlier conversation may still be cacheable, but the complete reread is fresh input and then remains in the model's context.

Tether's real advantage is therefore:

> Maintain an exact base understanding once, then transport the smallest sufficient sequence of artifact changes and review events.

That is a substantial advantage. It reduces fresh input, context growth, compaction pressure, latency, and irrelevant material competing for model attention. It remains useful when provider caches are cold, unavailable, or nearly free.

The current implementation fulfills this well for annotation-only turns. It does not yet fulfill it for body edits, fresh sessions, or compaction recovery. The interface has a good first two rungs—`pending` and `thread`—but then jumps to an unnecessarily large full-document response.

| Dimension | Current result |
| --- | --- |
| Annotation-only incremental transport | Strong |
| Separation of body and review history | Strong |
| Provider prefix-cache compatibility | Positive but indirect |
| Body-edit continuity | Weak |
| Proportional context escalation | Partial |
| Fresh-session or post-compaction recovery | Weak |
| Agent workflow instructions | Semantically sound, operationally incomplete |
| Cross-provider portability | Strong foundation |
| Cross-artifact portability | Promising model, missing artifact context contract |

## The cache model Tether should optimize

Three costs should remain distinct in product language and architecture.

### 1. Provider prefix computation

OpenAI, Anthropic, and Google reuse previously computed model state when a later request begins with matching content. Provider rules differ in minimum size, lifetime, explicit controls, routing, and billing, but the common unit is a request prefix—not an arbitrary repeated substring.

Tether cannot guarantee these hits from inside a generic CLI or MCP server. The harness constructs the final request and may change the model, tool catalog, system content, effort, compaction state, or gateway. Those changes can outweigh anything Tether does.

### 2. Fresh-token transport

Every Tether tool result newly delivered to the model must be processed at least once. A compact event packet is cheaper than a complete artifact even if the earlier conversation is fully cached. This is the dimension Tether controls most directly.

### 3. Context and attention occupancy

Cached tokens still occupy the model's context. Repeated full-artifact reads accelerate compaction and give the model more redundant material to search. Provider discounts do not remove this cost. For OpenAI, cached tokens also continue to count toward token rate limits.

For Tether, the durable design priority should be **incremental context fidelity**: deliver the least new material that preserves correct shared understanding. Provider cache preservation is one supporting mechanism, not the whole claim.

## What the current implementation gets right

### The body and annotation ledger have independent revisions

Body saves preserve the existing ledger, while review mutations append to the ledger without changing the body revision. This gives the product a clean conflict boundary and lets an agent distinguish proposal changes from conversation changes.

The embedded ledger also keeps review history attached when a file moves or is renamed. Its terminal position preserves almost all preceding file bytes when events are appended. That is useful for portability and for any integration that deliberately places a stable artifact prefix into a provider request.

However, the terminal ledger's physical position is not what produces most savings in Codex or Claude Code. Those harnesses append a later file read after the prior conversation rather than recognizing the repeated file as an independently cacheable substring. The savings come from Tether avoiding that later full read.

### `pending` is compact and actor-specific

The CLI-facing `pending` response contains current body and ledger revisions, the actor's acknowledgement, the maximum sequence, and only other-actor events after that actor's watermark. It does not include the document body or derived thread objects.

On the current product plan, a one-event `pending` response measured 816 bytes. An empty steady-state response observed in the review history was about 614 bytes. A new comment includes the comment, selected quotation, and bounded prefix and suffix. Replies and state changes are smaller.

This is an appropriate default interaction: cheap enough to poll, sufficient to decide whether more context is needed, and independent of document length.

### `thread` is a reasonable second rung

`thread` returns one current thread: its originating comment, replies, status, and latest event. The current product-plan example measured 1,852 bytes. For a question or instruction whose local quotation is enough, this is proportionate.

### Mutations return summaries rather than snapshots

Reply, resolve, reopen, acknowledge, and save operations return revisions, sequence, and unresolved count rather than returning the whole document. This keeps ordinary interaction bounded.

### Observed resolution behavior matches the intended social contract

The retained ledgers show the desired pattern in recent use:

- agents replied to questions and acknowledged what they had processed;
- the questions remained open until Hart resolved them;
- completed instruction threads were resolved without requiring Hart to reread redundant detail.

The product-plan thread followed the same sequence: Hart comment, assistant reply, assistant acknowledgement, Hart resolution.

This is evidence about the resulting state, not a complete command trace. Tether currently has no dedicated audit log that proves which interface produced every historical event.

## Where the implementation falls short

### 1. Body changes are detectable but not inspectable incrementally

`pending.bodyRevision` reports the current body revision. The actor acknowledgement records the revision previously seen. An agent can compare the two and infer that the body changed.

The response does not say this directly, and no operation explains what changed. There is no revision diff, section read, range read, search result with bounded context, or current block around a thread. The next portable action is `document read`.

Recent behavior demonstrates the gap:

- one review turn used `pending`, fetched two threads, and then read the complete document;
- another used `pending`, then relied on `git diff` to inspect a body edit before reading the thread.

Git supplied the missing delta only because that document was tracked and the working-tree baseline happened to be useful. It is not a Tether contract and will not generalize to untracked files, unsuitable Git baselines, websites, decks, images, or audio.

This is the largest mismatch between Tether's intended design and its present behavior.

### 2. The agent-facing full read is more than twice the body size

The control endpoint returns the browser-oriented `DocumentSnapshot` unchanged. That snapshot contains both `body` and the identical compatibility alias `content`, plus raw annotation events and derived threads.

Measured against the current product plan:

| Payload component | Bytes |
| --- | ---: |
| Markdown body | 31,554 |
| Complete source, including ledger | 33,628 |
| Embedded ledger | 2,074 |
| Agent `document read` response | 68,516 |
| Annotation state inside that response | 4,084 |

A 31.5 KB body therefore becomes a 68.5 KB tool result. Exact token counts depend on the model tokenizer, but the avoidable duplication is deterministic.

The agent read contract should not reuse the browser bootstrap type. A full agent snapshot should contain one body copy, its revision, and only metadata required to interpret that body.

### 3. The context ladder has a missing middle

The present ladder is effectively:

```text
pending event → full thread → full document
```

The intended ladder should be:

```text
status/pending
→ full selected thread
→ verified local artifact context
→ bounded revision diff or section
→ full snapshot
```

A thread may need only its containing paragraph, heading path, neighboring block, slide, DOM node, image region, or transcript window. Tether should make that small escalation possible without forcing the agent to ingest the complete artifact.

Every bounded response should state whether it was truncated and expose a clear next-broader request.

### 4. The agent interface cannot verify orphan status

The browser resolves a text quotation against its live ProseMirror document. Server-side `pending`, `thread`, and document snapshots derive thread state without the rendered-text projection, so the CLI receives the original quotation and revision but not a verified current location or orphan status.

This produces an asymmetry: the human can see an orphaned thread while the agent tool cannot reliably know that it is orphaned.

Locator resolution belongs in the artifact service contract. For Markdown, the server and browser should share a canonical parser/projection. Other artifacts should supply their own locator resolver.

### 5. Acknowledgement identity is overloaded

The current `actor` string means both message author and pending-consumer cursor. Historical use changed from `codex` to `assistant`; the later identity then saw earlier Codex-authored events as external and replayed a much larger pending set. One observed actor migration produced a 10,197-byte pending response instead of the normal sub-kilobyte state.

The opposite collision is also possible: concurrent agents sharing `assistant` can advance one another's watermark.

The protocol should distinguish:

- display authorship, such as `user` or `assistant`;
- a review-party or consumer identity that owns a cursor.

For the present single-user product, one stable assistant review party may be enough. The distinction should still exist in the contract before multiple harnesses are supported.

### 6. The acknowledgement cursor is too easy to misuse

The safe acknowledgement boundary is the `maxSequence` returned by the `pending` call the agent actually processed. Reply and resolve mutations also return a newer maximum sequence. If the agent acknowledges that later value, it can skip a user event inserted concurrently between its poll and mutation.

An opaque cursor returned by `pending` and accepted directly by `acknowledge` would remove this ambiguity. At minimum, instructions must say to acknowledge only the sequence received from the original pending response.

### 7. Instructions explain thread etiquette but not the economical workflow

The current shared AGENTS.md guidance correctly distinguishes acknowledgement from resolution and keeps thread-level detail out of global conversation. It does not tell an unfamiliar agent to:

- start with Tether `pending` rather than a raw file read;
- use the canonical assistant identity;
- compare current and acknowledged body revisions;
- fetch only the threads or local context it needs;
- reserve full snapshots for genuine need;
- acknowledge only the cursor it received;
- use Tether's serialized mutation path for body changes.

The README documents some of this, but an agent in another repository is not guaranteed to read Tether's README. A small routing instruction plus a focused workflow skill or stable MCP tool description is justified.

### 8. Append-only review history has an eventual size cost

Append-only events are simple, portable, and conflict-friendly. They also grow indefinitely. In the current encoding, acknowledgement and state-transition metadata can add hundreds of bytes per turn even when the substantive reply is short. This does not enlarge acknowledged `pending` responses, but it increases raw file size, parsing work, browser state, and full-read cost.

This is not an immediate blocker. Establish a byte or event threshold and later checkpoint old resolved history into a compact terminal-ledger state. Rewriting only the ledger preserves the Markdown body bytes. The checkpoint must remain lossless enough for the intended audit history.

### 9. Fresh sessions and compaction have no deliberate rehydration path

Codex and Claude Code both eventually compact long conversations. Provider cache entries also expire. After either boundary, the model may no longer have the base artifact understanding to which Tether deltas refer.

The current fallback is a full document read. A purpose-built rehydration response should instead provide:

- artifact identity and current revision;
- a compact structural outline or synopsis;
- unresolved threads and current owners;
- recent decisions or acknowledged changes;
- explicit links for selected sections or a full snapshot.

This makes recovery intentional rather than treating the full artifact as the only safe reset.

## Provider and harness implications

The detailed, dated source matrix is in [provider-cache-behavior.md](./references/provider-cache-behavior.md).

### OpenAI and Codex

OpenAI caches the complete rendered request prefix, including instructions, tools, conversation history, tool calls, and tool results. Current GPT-5.6 caching supports implicit and explicit breakpoints, requires a 1,024-token visible prefix, and uses a 30-minute minimum lifetime after write or reuse. Changes to model, tools, effort, output settings, or compaction can change the rendered prefix.

Codex's accumulated conversation means a compact Tether result appends cleanly. A complete reread does not necessarily destroy the earlier prefix cache; it creates a large fresh suffix and permanently enlarges later context. This correction matters because it identifies what Tether can actually control.

### Anthropic and Claude Code

Anthropic caches `tools → system → messages` prefixes, with automatic or explicit breakpoints. Claude Code documents that repository edits do not retroactively change prior reads; skills append instructions; MCP changes are cache-safe when tools are deferred but can invalidate the system prefix when definitions are loaded upfront.

Claude Code cache lifetime depends on authentication and configuration. Subscription-backed main conversations normally use one hour while within plan usage; API-key and cloud-provider conversations default to five minutes unless configured otherwise. Tether cannot preserve an expired provider cache, but a compact pending turn is still much cheaper than a cold full-artifact reread.

### Gemini

Gemini 2.5 and newer models provide best-effort implicit caching. Explicit cache objects are also available through the Generate Content API and are especially relevant to large documents and multimedia. Gemini CLI caching depends on authentication; common OAuth Code Assist use does not receive the same caching path as API-key or Vertex use.

This reinforces the need for a provider-neutral delta protocol. Explicit provider caches may become useful optional adapter capabilities for immutable artifact snapshots, especially video and audio, but they should not enter Tether's portable core.

### Bedrock and gateways

Claude through Bedrock does not imply Anthropic-direct cache behavior. Model support, minimums, routing, and hit guarantees can differ. Gateways may forward, reject, or strip caching controls. Tether should record provider/harness capabilities when known and avoid inferring cache success.

## Recommendations, highest leverage first

### 1. Define the product invariant as incremental context fidelity

Use this as the core contract:

> Tether maintains a revision-addressed artifact understanding and transports the smallest sufficient delta, thread state, or local context needed for the next shared decision.

Measure provider cache hits where available, but do not make them the only success criterion.

### 2. Make body-change continuity first-class

Add explicit fields to the default status response:

```json
{
  "bodyRevision": "sha256:...",
  "acknowledgedBodyRevision": "sha256:...",
  "bodyChangedSinceAck": true,
  "deltaAvailable": true
}
```

Then add a bounded diff operation between known revisions. A practical design is a content-addressed, best-effort revision cache owned by Tether rather than a required per-document sidecar. The embedded document ID and body hash identify snapshots; moving a file does not break the cache. If the basis is unavailable, return that fact and escalate to section or snapshot reads.

This cache is disposable acceleration state, not the portable source of truth. That distinction avoids the relocation and drift problems of required sidecars.

### 3. Add a stable context ladder

Shape the host-neutral interface around operations equivalent to:

```text
review pending
review thread <id>
artifact context --thread <id> --budget <n>
artifact diff --from <revision> --budget <n>
artifact outline
artifact snapshot
```

Do not encode Markdown headings into the core contract. Each artifact adapter should implement outline, locator, bounded context, diff, and snapshot for its medium.

### 4. Remove full-read duplication immediately

Make the agent read response independent of browser bootstrap. Return one body copy and revisions. Do not include `content`, raw events, derived threads, or acknowledgements unless explicitly requested.

Add payload-shape tests so the compact path cannot regress:

- pending excludes artifact body and full thread state;
- thread size depends on that thread, not total ledger history;
- body-only snapshot contains one body copy;
- bounded context and diff responses declare truncation;
- response growth follows requested content, not whole-artifact size.

### 5. Give agents verified locator status and current local context

`thread` or `artifact context --thread` should report whether the location is resolved, ambiguous, or orphaned against the current artifact revision. It should return the current containing context when resolved and remain replyable when orphaned.

This also creates the right abstraction for DOM nodes, slide objects, image regions, and audio time ranges.

### 6. Separate review-party identity from authorship and use opaque cursors

Keep human-readable authorship simple. Give each reviewing party an explicit cursor identity and make `pending` return an opaque cursor that `acknowledge` consumes unchanged.

This prevents harness-name drift, avoids accidental skipping, and clarifies how multiple assistants share or separate review responsibility.

### 7. Package one small workflow instruction and one stable tool surface

Use a short persistent trigger to recognize Tether review work. Put the operational sequence in a focused skill until MCP materially improves discovery and structured calls.

When MCP arrives:

- keep one fixed server and stable schemas;
- do not create dynamic tools per artifact;
- do not put current artifact state in tool descriptions;
- prefer deferred discovery where the harness supports it;
- return dynamic state only in results.

### 8. Add a rehydration operation

Design explicitly for cold provider caches, new sessions, and compaction. The response should be bounded and structurally informative, with a full snapshot as an explicit final escalation.

### 9. Add development telemetry at the Tether boundary

Do not add user-facing monitoring yet. In development, record:

- response bytes and estimated tokens by operation;
- context-ladder rung used;
- full snapshots requested;
- body diffs served or unavailable;
- repeated event content;
- actor/cursor migrations;
- ledger bytes and event count.

Provider cache-read fields belong to the provider or harness. Capture them only through an adapter that actually receives authoritative usage data; never infer a hit from Tether behavior.

### 10. Add eventual ledger checkpointing

Defer until real documents approach a chosen threshold. Preserve open threads and required history, compact old resolved event chains, and keep the body revision independent.

## Generalizing beyond Markdown

The reusable core is not a Markdown editor with comments. It is:

```text
revision-addressed artifact
+ immutable review-event stream
+ artifact-specific locators
+ bounded context resolver
+ revision delta provider
+ explicit full-snapshot fallback
```

| Artifact | Local locator | Bounded context | Delta |
| --- | --- | --- | --- |
| Markdown | rendered quote + structural path | block, section, heading path | text hunks |
| Website | DOM/semantic node + text quote | component or section subtree | DOM/content patch |
| Presentation | slide and object identity | slide, notes, neighboring slides | object/slide changes |
| Image | region + semantic label | crop, low-resolution frame, nearby objects | layer/region change |
| Audio | time range + transcript quote | transcript window and audio segment | transcript/edit timeline |

The model should encounter the same escalation semantics in every medium even though the locator and payload are different. This is the architecture most likely to preserve both user and model attention as Tether expands.

## Bottom line

Tether's annotation path already demonstrates the product's core value: a sub-kilobyte change packet can replace a tens-of-kilobytes reread while preserving a durable, page-attached dialogue.

The next build should not focus on deeper provider-specific cache controls. It should close the gaps Tether itself controls:

1. body revision deltas;
2. verified local context;
3. a nonduplicating agent snapshot;
4. safe cursors and stable review identity;
5. cold-session rehydration.

Once those exist, provider-specific cache adapters can improve cost further without distorting the portable interaction model.
