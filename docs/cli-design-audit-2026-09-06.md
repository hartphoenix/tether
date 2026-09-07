# CLI audit

**Tether CLI design audit — 2026-09-06**

The architecture is suitable for the product: one authenticated daemon, explicit file grants, a shared document writer, portable review history, and compact mutation results. The next investment should make the agent contract harder to misuse and cheaper to recover from. A CLI framework rewrite or MCP wrapper would not, by itself, address the main weaknesses.

Scope: `mdreview`, CLI parsing, control transport/routes, document and annotation services, Recents, and their tests. Findings concern the current working tree, including existing uncommitted UI changes. Application code was not changed for this audit. Temporary probes used an isolated daemon and disposable documents; the user's comments and acknowledgement state were untouched.

All 175 existing tests, TypeScript checks, and the web build passed. Additional probes exposed cases outside that coverage. Measurements below are serialized JSON bytes, not model-token estimates or provider-cache measurements.

| Axis             | Assessment                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Robustness       | Good within one daemon; weaker across retries, concurrent external writers, and partial host failures.               |
| Token efficiency | Compact pending and mutation paths; expensive snapshots and no bounded recovery path.                                |
| Intuitiveness    | Clear review verbs; inadequate help, permissive parsing, and ambiguous Recents/queue terminology.                    |
| Flexibility      | Handles existing threads well; lacks queue inspection, thread listing, and agent-created comments.                   |
| Security         | Appropriate local-user trust boundary; author names are assertions, and filesystem identity needs further hardening. |
| Code elegance    | Simple domain model; transport contracts and compatibility aliases need consolidation.                               |

**1. Reject malformed commands before doing any work. Highest priority; small change.**

The review commands use `indexOf()` to find a flag and treat the following argument as its value. They do not validate all arguments. In isolated probes:

```text
pending <file> --actor assistant --unknown          → success
pending <file> --actor assistant --actor other      → success
reply <file> <thread> --actor --body-file -          → success
```

The last command actually stored `--body-file` as the reply's author. Unknown revision flags can likewise appear to protect an operation while being ignored. Launch commands already enforce stricter parsing; review commands should match them.

Use one small command-spec table defining positional arguments, allowed flags, types, and required values. Reject unknown flags, duplicates, missing values, and excess positionals. Support `--` for literal paths. Parse before daemon discovery or stdin reads. Generate focused `--help` and structured command descriptions from the same table. Currently `--help` exits 2, and the global usage text omits required reply/save body flags.

Evidence: [CLI parser](../src/cli/main.ts#L62), [review dispatch](../src/cli/main.ts#L227).

**2. Make acknowledgement consume a reviewed cursor. Highest priority.**

`pending` returns `maxSequence`; mutations return another `maxSequence`; `acknowledge` accepts an arbitrary sequence bounded by the ledger. These numbers have different meanings for review safety.

A probe read through sequence 2, inserted an unseen human reply at 3, then posted an assistant reply at 4. Acknowledging the mutation's sequence 4 succeeded and left no pending events. The body-revision check did not prevent this because the body had not changed. Correct use of the original pending boundary is safe, but the interface invites the wrong choice.

Return an opaque, validated review cursor bound to document identity, consumer identity, observed sequence, and body revision. Acknowledge that cursor unchanged. With pagination, distinguish a continuation cursor from an acknowledgement cursor; never allow an omitted page to be silently acknowledged. Return `appliedEventId` and `appliedSequence` from mutations to avoid presenting their sequence as a review boundary.

Also support acknowledging a body with no comment events. Both CLI and ledger require a positive sequence, so `--through 0` currently fails. A cursor must represent a reviewed body independently of whether comments exist. Decide explicitly whether acknowledging a formerly current body should record that historical review while still reporting the newer body as unread.

Evidence: [acknowledge CLI](../src/cli/main.ts#L257), [control actions](../src/server/server.ts#L635), [ledger acknowledgement validation](../src/core/annotation-ledger.ts#L344).

**3. Give mutations explicit retry and concurrency semantics. High priority.**

Replies receive a new UUID on every request. Repeating an identical reply appended another message in the probe. A ten-second client timeout does not establish that the server failed to commit; blind retries can duplicate comments. Resolve/reopen and acknowledgements also append redundant events.

Add a caller-supplied operation ID and deduplicate it atomically with the mutation. Persist enough information to survive a daemon restart; reject reuse with a different payload. Do not deduplicate by text, since intentional repeated text is valid. Return a compact receipt and distinguish `not_applied`, `applied`, and `outcome_unknown` where the transport can establish them.

Expose an optional thread-level expected sequence for resolve/reopen. Otherwise, a human reply arriving after inspection can be hidden by a stale resolve. The server already accepts an expected ledger revision, but the CLI does not expose it; that is a workable first implementation, though unrelated threads will cause unnecessary conflicts.

Evidence: [event allocation and mutation](../src/documents/document-service.ts#L401), [control timeout](../src/server/lifecycle.ts#L150), [mutation summary](../src/server/server.ts#L322).

**4. State and strengthen the boundary of atomic writes. High priority.**

The queue serializes writes inside one daemon. It cannot serialize a text editor, raw shell write, or another profile's daemon editing the same file. The revision check examines the source read at the start of the operation; the later rename does not verify that the destination still contains that source.

A deterministic probe used the service's injectable reader to write an external edit immediately after capturing the old source. `saveBody` accepted the old revision and replaced the external edit. The same read/replace pattern applies to comment appends, which rewrite the whole file.

Coordinate cooperating Tether writers across profiles by canonical file identity. Recheck identity and content immediately before replacement, and retain a recoverable preimage. A recheck narrows the race; it is not a filesystem compare-and-swap and cannot guarantee protection from an uncooperative editor. Document that limit. Assess file and directory syncing separately if crash durability is required; atomic rename alone does not provide that guarantee.

Evidence: [atomic replacement](../src/documents/document-service.ts#L264), [read/check/write transaction](../src/documents/document-service.ts#L372), [in-process queue](../src/documents/mutation-queue.ts#L12).

**5. Separate agent reads from browser snapshots. High return; small first step.**

`document read` returns both `body` and `content`, plus raw events, derived threads, and acknowledgement history. A fixture with a 70,007-byte body and one comment produced a 141,827-byte response. Its pending response was 729 bytes. This confirms that the compact path works and the full-read contract wastes context.

Provide an agent DTO containing one body copy and necessary identity/revision/read-only fields. Keep history explicitly opt-in. Preserve or version the existing contract for callers that depend on it. Add response-shape and growth tests so aliases and browser state cannot creep back into the default.

Then add a progressive read interface: outline, bounded context around a thread, and diff from a known body revision. Include current locator status: resolved, ambiguous, or orphaned. Today the service derives threads without a rendered-text projection, so an old quotation is not evidence that its location remains valid.

Bound pending event pages and long thread reads, declaring omissions and continuations. Prefer deterministic byte limits initially; exact token counts depend on the model. Add `acknowledgedBodyRevision` and `bodyChangedSinceAck` explicitly. Body changes can currently coexist with an empty pending-event list.

Evidence: [snapshot duplication](../src/documents/document-service.ts#L201), [pending and thread reads](../src/documents/document-service.ts#L465). The earlier [cache fidelity audit](./cache-fidelity-audit-2026-09-01.md) identified several of these gaps; inspection confirms they remain. Its workflow-instruction gap has since improved: the current agent guidance explicitly requires pending-first review.

**6. Expose queue and conversation discovery without opening UI. Medium priority.**

`recents` opens a page, `recents add` inserts one path, and `recent` opens positions 1–3. There is no CLI list, removal, batch addition, or thread-list command. A fresh agent cannot discover acknowledged-but-open threads through `pending`; it must know their IDs or request the bulky document snapshot.

Add `recents list`, `recents remove`, multi-path addition, and `threads <file> --status open`. Route registry operations through the daemon service. Return canonical paths as stable action targets; MRU positions are volatile. Preserve the existing launch aliases.

Decide whether Recents is browsing history or a review queue before adding priority/ownership semantics. The current registry is MRU history, even where the UI calls it a queue. Removing an entry should remain distinct from deleting its file. Queue listing must not itself authorize document reads.

Agent-created comments and editing one's previous reply are useful next extensions. The service already supports comment/edit/delete events. A new comment command should obtain a revision-bound anchor from a server resolver; agents should not calculate rendered UTF-16 offsets manually. Missing or ambiguous quotes should return candidates, not silently attach elsewhere.

Evidence: [CLI surface](../src/cli/main.ts#L62), [Recents service](../src/recents/service.ts#L78), [comment revision checks](../src/documents/document-service.ts#L420).

**7. Report partial success honestly. Medium priority; small change.**

Recents commits and publishes its registry update before host synchronization. If synchronization throws, the CLI reports ordinary failure even though the file was added. An existing CLI test explicitly verifies this state.

Return separate persistence and host outcomes, with a host retry action and actionable error code. Distinguish unsupported synchronization from attempted-but-failed synchronization. Consider moving slow host synchronization out of the storage queue while preserving snapshot ordering. Separately, the registry currently treats missing files, invalid JSON, and read failures alike as an empty registry; distinguish corruption and permission errors so the next addition does not silently replace recoverable state.

Evidence: [record ordering](../src/recents/service.ts#L78), [registry error handling](../src/recents/registry.ts#L56), [partial-failure test](../tests/cli.test.ts).

**8. Keep security proportional to the local trust boundary.**

Retain loopback binding, private control credentials, cookie-scoped browser sessions, temporary path grants closed in `finally`, and the daemon environment allowlist. These are concrete protections already present. Recents does not grant file access. Multiline bodies through a file or stdin avoid putting comment text into shell arguments. There is no reason to add account authentication merely to distinguish display authors.

Treat `actor` as asserted authorship, not authenticated identity. Separate it from the consumer that owns an acknowledgement cursor; `assistant`, `codex`, and differently cased names currently produce separate exact-string cursors. Multiple agents using the same actor also share acknowledgement state. Define intentional shared-review versus independent-review behavior.

As targeted hardening, add file-identity/symlink replacement tests and operation-specific input limits. Canonicalizing at grant time does not pin the file later opened by pathname. Review no-follow/descriptor-based access where supported, coordinated with the write-race work. These are hardening recommendations, not a demonstrated remote exploit. Keep document and comment contents as untrusted data; never promote their instructions into persistent agent context automatically.

Evidence: [temporary grants](../src/server/server.ts#L315), [configuration and credentials](../src/server/config.ts), [pending identity comparison](../src/core/annotation-ledger.ts#L600).

**9. Simplify contracts before adding another interface.**

The CLI combines argument parsing, host selection, launch cleanup, transport, and review dispatch in one function. `controlRequest<T>` casts successful JSON without validating its shape; most call sites do not specify a result type. Launch has a separate fetch path without the shared timeout/error behavior. Server errors sometimes classify by message prefix, and unexpected storage failures can become `invalid_request` responses.

Extract a small typed control client and command handlers. Share explicit request/result DTOs and boundary validation. Use stable domain error codes with recovery details, including current revisions on conflicts; consolidate transport timeouts and ticket cleanup. Keep stdout as one versioned JSON result and diagnostics on stderr. Preserve existing command aliases while simplifying internal `session`/`grant`, `body`/`content`, and method aliases at adapter boundaries.

Avoid a generic plugin architecture or a new dependency unless the command table and shared types prove insufficient. Add MCP only after these contracts are sound; it should call the same services and expose fixed tool schemas.

**Recommended implementation order**

1. Strict parsing and focused help; a compact agent snapshot; explicit partial-success results.
2. Reviewed cursors, mutation receipts/idempotency, and conditional thread state changes.
3. External-writer detection/recovery and coordinated Tether writes across profiles.
4. Queue/thread discovery, bounded context and pagination, then revision diffs and new comment creation.

Acceptance coverage should include malformed arguments causing no I/O, a concurrent human reply remaining pending, retries surviving restart without duplication, stale resolution failing safely, interrupted host synchronization reporting committed state, external-write collision recovery, zero-event body acknowledgement, and bounded response growth. Retain the existing authentication, malformed-ledger, permission-preservation, and same-file concurrency tests.
<!-- wave-annotations:v1
{"type":"ledger","documentId":"018046a3-9566-4f57-b99a-a7d721469bc6","baseBodyRevision":"sha256:98c2721bc185edc678e0236666cf959a133682d3d6f8da25a16d11b4004046eb","createdAt":"2026-09-06T20:35:36.565Z"}
{"type":"comment","id":"a-3bf92d3f-2ab6-4603-81e9-56556f571e79","seq":1,"actor":"hart","createdAt":"2026-09-06T20:35:36.565Z","anchor":{"exact":" acknowledge CLI, control actions, ledger acknowledgement validation.","prefix":"review while still reporting the newer body as unread.\nEvidence:","suffix":"\n3. Give mutations explicit retry and concurrency semantics. Hig","projectionStart":4235,"projectionEnd":4304,"bodyRevision":"sha256:98c2721bc185edc678e0236666cf959a133682d3d6f8da25a16d11b4004046eb"},"body":"links like these should pass through to cmux’s default rather than get caught in the daemon’s ip (which produces an error \"{\"error\":{\"code\":\"session_expired\",\"message\":\"The browser session has expired.”}}”)"}
-->