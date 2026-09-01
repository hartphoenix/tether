# Provider and harness cache behavior

**Verified:** 2026-09-01
**Purpose:** durable design reference for Tether's agent and artifact protocols

Caching behavior changes quickly. Reverify these sources before implementing provider-specific controls. Keep verified provider facts separate from architectural inferences.

## Common model

All providers reviewed here optimize reuse of previously processed request content. The portable assumption is exact or sufficiently identical **prefix** reuse. None should be treated as a general cache for repeated substrings appearing later in a prompt.

For Tether:

- an appended CLI or MCP result normally preserves the earlier conversation prefix;
- rereading a changed artifact normally adds a fresh full-artifact suffix rather than retroactively changing the earlier read;
- compact deltas save fresh input and context even when provider cache hits are perfect;
- model, tool, system, effort, gateway, and compaction changes remain outside Tether's control.

## OpenAI API

Primary source: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

Current verified behavior:

- OpenAI caches the rendered request prefix, including hidden instructions, developer content, tool definitions, conversation history, tool calls, tool results, text, supported documents, images, and audio.
- Reuse requires the rendered prefix to match through an eligible breakpoint.
- Model, tool definitions or ordering, parallel-tool settings, structured output, reasoning effort, verbosity, and context compaction can alter the cacheable prefix.
- GPT-5.6 and later require at least 1,024 visible input tokens; older models generally require 2,048.
- GPT-5.6 supports implicit and explicit breakpoints. Cache writes cost 1.25 times ordinary input and reads cost 0.1 times.
- GPT-5.6 cache entries have a 30-minute minimum lifetime after their latest write or reuse; earlier models use model-dependent in-memory or extended retention.
- Authoritative usage fields include cached and cache-write tokens.
- Cached tokens still occupy context and count toward API token rate limits.

Harness source: [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)

Relevant Codex behavior:

- Codex sends accumulated conversation state and relies heavily on prefix caching.
- Stable model choice, tool catalog, ordering, working context, and sandbox configuration matter to reuse.
- Configuration changes should append rather than rewrite earlier context when possible.

Architectural implication: Tether should keep tool schemas stable and results compact. It should not assume Codex exposes artifact-specific explicit cache breakpoints.

## Anthropic API and Claude Code

Primary API source: [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Current verified behavior:

- Anthropic's prefix hierarchy is `tools → system → messages`.
- Automatic caching advances a breakpoint with a growing conversation. Explicit caching supports multiple deliberate breakpoints.
- The default lifetime is five minutes; a one-hour lifetime is available at higher write cost.
- Five-minute writes cost 1.25 times ordinary input, one-hour writes cost 2 times, and reads cost 0.1 times.
- Explicit lookback checks at most 20 blocks per breakpoint.
- Minimum cacheable sizes vary by model, from 512 to 4,096 tokens in the current model set.
- Tools, system messages, ordinary messages, images, documents, tool calls, and tool results can be cached.
- Changing tool definitions invalidates tools, system, and messages. Tool choice, media presence, thinking, and effort can invalidate later layers.
- Usage separates cache creation, cache reads, and uncached input.

Harness source: [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)

Relevant Claude Code behavior:

- Each request resends system instructions, project context, conversation history, tool results, and the new message.
- File contents enter context only when read. Editing a file does not alter the earlier read; Claude Code appends a change notice and rereads only if needed.
- Skills and commands append instructions as messages and preserve the earlier prefix.
- Compaction replaces conversation history and invalidates that layer.
- Deferred MCP tools preserve the prefix when servers or definitions change. Always-loaded definitions can invalidate it.
- Subscription-backed main conversations use a one-hour lifetime while within plan usage. API-key and cloud-provider conversations default to five minutes unless configured otherwise.
- Cache performance can change behind gateways that reject or strip cache controls.

Architectural implication: a concise Tether skill is cache-safe but still costs new tokens when injected. A fixed, deferred MCP surface is preferable to dynamic per-artifact tools.

## Gemini API and Gemini CLI

Primary API sources:

- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Generate Content context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
- [Zero data retention](https://ai.google.dev/gemini-api/docs/zdr)

Current verified behavior:

- Gemini 2.5 and newer models use implicit caching automatically, but savings are best-effort rather than guaranteed.
- Large common content should appear early and requests should share similar prefixes.
- Current implicit minimums are 2,048 tokens for Gemini 2.5 Pro and Flash and 4,096 for the listed Gemini 3.x models.
- Explicit cached-content objects are available through the Generate Content API, default to a one-hour lifetime, and can be extended.
- Explicit caching adds storage cost based on cached tokens and duration.
- Cached content is treated as a prompt prefix and is suited to repeated analysis of long documents and multimedia.
- Usage metadata reports cache hits.

Harness source: [Gemini CLI token caching](https://geminicli.com/docs/cli/token-caching/)

Relevant Gemini CLI behavior:

- API-key and Vertex AI authentication receive automatic token-caching optimization.
- OAuth Google Personal and Enterprise use through Code Assist does not support the same cached-content path.
- `/stats` reports savings where supported.

Architectural implication: Tether's provider-neutral delta path remains useful where Gemini CLI caching is unavailable. Explicit Gemini cache objects are a possible future adapter optimization for immutable large or multimedia snapshots, not a core dependency.

## Amazon Bedrock

Primary source: [Prompt caching for faster model inference](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)

Current verified behavior:

- Cache support, minimum size, explicit controls, lifetime, and usage fields vary by model and Bedrock API.
- Prefix matching remains central.
- Cross-region routing can create additional writes, and supported caching does not guarantee a hit.

Architectural implication: do not infer Anthropic-direct behavior merely because the selected Bedrock model is Claude. Record provider and gateway capabilities separately from model identity.

## Design rules derived from these sources

These are Tether design inferences, not provider promises:

1. Optimize fresh-token volume and context occupancy first; both remain under Tether's control.
2. Keep stable instructions and tool schemas fixed within a session.
3. Append dynamic state through tool results rather than rewriting system instructions or tool definitions.
4. Treat provider cache telemetry as authoritative only when the harness or provider exposes it.
5. Make cold-cache behavior efficient; provider lifetimes are shorter than many human review pauses.
6. Provide deliberate rehydration after compaction or a fresh session.
7. Keep provider-managed explicit caches optional and adapter-specific.
8. Preserve one portable escalation ladder from delta to local context to full artifact across every medium.
