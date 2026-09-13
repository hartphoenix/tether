# CLI live audit — 2026-09-13

The live workflow passed data-preservation and review-handling checks, but did not fully pass the signal and downstream UX criteria in [[cli-improvement-plan-2026-09-13.md|the improvement plan]]. Four discrepancies remain below.

## Method

A separate `gpt-5.6-luna` agent operated the current checkout's CLI on an isolated test document. It received ordinary document-review tasks and the documented review conventions, without expected audit answers or advance knowledge of an injected concurrent edit. A logging wrapper preserved CLI arguments, stdout, stderr, and exit status; on the first save it simulated a user edit before invoking the real CLI.

Two human comments requested an explanation and a wording change. After Luna handled them, a simulated human reply approved a further change. Additional tasks exercised a mixed-success import, a nonexistent document, and a successful registration with a simulated host shortcut failure. Both test services used separate runtime/config directories; the warning service used the real daemon with a fault-injecting host adapter.

There were 29 Luna CLI calls and three parent calls seeding human comments/replies, before parent verification and cleanup. Every response was one protocol-1 JSON line, stdout remained parseable, stderr was empty, and process exit status matched the success/failure envelope. Partial import returned success with an explicit `partially_applied` outcome, which Luna correctly interpreted.

## Verified behavior

| Scenario | CLI result and observed agent behavior |
| --- | --- |
| Ordinary registration | Success contained only `added` paths, without the registry or unsupported-host chatter. Luna reported completion. |
| Review discovery | Luna began with `pending`, fetched each thread, used local context, and acknowledged the exact original cursor after responding. |
| Concurrent user edit | The stale save was rejected. Luna reread, preserved the user's added sentence, and saved against the new revision. |
| Human decision | Luna initially left the undecided sentence unchanged and replied with an interpretation; it changed the sentence only after the simulated approval. Replies remained available for human review. |
| Follow-up acknowledgement | Luna acknowledged the second original cursor; the final pending result contained no unreviewed events. |
| Partial import | The new document was imported; the existing destination was unchanged. Luna identified the unresolved collision and did not invent a new destination. |
| Missing document | The CLI preserved `ENOENT`, `stat`, and the path, with `outcome: not_applied`. Luna reported failure accurately; independent registry inspection confirmed no missing-file entry. |
| Applicable host failure | Registration succeeded with an actionable warning preserving `EACCES`, operation, and path. Luna distinguished registration success from shortcut failure and did not repeat the registration. |

Independent file inspection confirmed both approved edits and the concurrent user addition in the final document, exact preservation of the existing import destination, and the expected new imported file.

## Discrepancies

1. **A rejected save reports an unknown outcome.** The error message correctly says the body changed before the save was applied, but `details.outcome` says `outcome_unknown`. The revision check in `src/documents/document-service.ts` throws before mutation without specifying `not_applied`; the lifecycle request wrapper supplies its generic mutation fallback. Set the known outcome at this precondition rejection, preserving uncertainty for failures whose application state is actually unknown. Luna recovered safely, but received contradictory evidence.

2. **Grouped help fails at a natural discovery point.** Luna tried `document --help`, which returned exit 2 and `Unknown command: document.--help`, followed by instructions to use command-specific help. It then tried `edit --help` before reaching `document save --help`. Group-level help should list supported subcommands rather than interpreting `--help` as a subcommand.

3. **Recovery advice can contradict a known outcome.** Missing-file registration correctly returned `not_applied`, but retained the generic advice `Inspect current state before retrying.` The wrapper builds this advice before merging the more precise server outcome. Derive fallback recovery guidance from the final outcome so a known preflight rejection does not imply uncertain application. Luna did not perform an unnecessary inspection in this case.

4. **Natural summarization still leaks implementation detail into the user conversation.** Luna's final report correctly described the results but included `EEXIST`, `ENOENT`, and “a host shortcut warning (EACCES on /tmp/simulated-wave-shortcuts.json).” Preserving that evidence for the agent is useful; this single run shows that compact structured output alone does not ensure a clean user explanation. The desired explanation would say the document was added but its recent-document shortcut could not be updated, reserving technical evidence for a relevant recovery decision. This is observed agent behavior, not proof of a general model tendency.

## Evidence and limits

- [Main CLI transcript](/tmp/tether-luna-live-EPyEOs/transcript.jsonl)
- [Host-warning CLI transcript](/tmp/tether-luna-live-EPyEOs/warning/transcript.jsonl)
- [Final test document](/tmp/tether-luna-live-EPyEOs/pilot.md)

These temporary files include parent verification and service-stop calls after the 32 scenario calls counted above. Both isolated services were stopped after testing.

Luna's inherited execution sandbox initially blocked loopback access; the CLI accurately reported `daemon_unreachable` with the underlying socket diagnostic, and escalation allowed testing. This was not a fresh-launch test of the previously corrected launcher configuration and does not contradict the user's successful fresh-shell test.

Human interaction was simulated through review commands and a file edit; the host failure was injected. This run did not test browser gestures, a real Wave shortcut update, installer/updater execution, or every fault boundary. The implementation's preceding complete check passed 312 tests plus TypeScript and web build checks; this observational pass made no runtime changes and did not rerun that suite.
