# CLI live audit — 2026-09-13

The live workflow passed data-preservation and review-handling checks, but did not fully pass the signal and downstream UX criteria in [[cli-improvement-plan-2026-09-13.md|the improvement plan]]. The initial run found the four discrepancies below.

Update: the implementation retest below verifies fixes for discrepancies 1–3. Discrepancy 4 remained observable in the test-framed runs; the later editorial scenario avoided diagnostic codes in user-facing prose with a brief role instruction.

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

## Implementation retest

Checkpoint `bd14403` preserves the implementation and initial audit before these fixes. The follow-up changes are limited to the document save preconditions, control-response recovery metadata, CLI help, and regression assertions:

- Save conflicts detected before replacement now explicitly report `not_applied`, including the final race check before rename.
- The client derives fallback recovery guidance from the final server-reported outcome, while retaining server details and unknown outcomes for transport failures.
- Group help lists subcommands, including `document save`, without starting a daemon.
- Global, group, and command help explain how to report results in plain language while keeping diagnostic evidence for agent recovery.

A fresh Luna agent repeated the full review workflow with new isolated fixtures, unaware of the injected concurrent edit or expected audit answers. It safely recovered from the stale save, preserved the user addition, handled the approval reply, preserved existing import files, and distinguished registration success from a shortcut warning. Independent transcript inspection confirmed `not_applied` with no unnecessary recovery advice for both the stale save and missing-file registration; the original filesystem diagnostic remained available. A parent live call verified grouped help, and regression checks cover every supported group. Final file and registry inspection confirmed the expected edits and imports with no missing-file registration.

The first retest still repeated diagnostic codes in its final summary. After tightening the help guidance, a second fresh Luna agent read that help and repeated the import, missing-file, and warning scenarios; it still included `EEXIST` and `EACCES` in its summary. When asked about the divergence afterward, it confirmed it had read the guidance and had copied diagnostic details instead of translating them. That follow-up was explanatory, not counted as a successful blind test.

Thus the three CLI behavior fixes pass. The downstream prose criterion does not: help guidance alone did not reliably control Luna's summarization in these runs. Diagnostic evidence remains intact, and no application output filtering was added to hide it. This is a bounded observation about these agent runs, not a claim that all models will behave the same way.

The final complete check passed **313 tests, 0 failures, 1,703 assertions**, plus TypeScript and the web build. Both isolated retest services were stopped; the user's preview service was left running. The sandbox and simulated-host limitations of the first run still apply.

- [Retest CLI transcript](/tmp/tether-luna-retest-h_mgfv5w/transcript.jsonl)
- [Retest shortcut-warning transcript](/tmp/tether-luna-retest-h_mgfv5w/warning/transcript.jsonl)
- [Retest final document](/tmp/tether-luna-retest-h_mgfv5w/pilot.md)

## Editorial scenario

A further fresh Luna agent received no earlier conversation or audit findings. Its task was framed as Hart asking for a practical revision of a small review-pilot proposal before sending it to Mira, followed by registration in Tether Recents. The document contained plausible scheduling, staffing, participant tasks, privacy, and follow-up details. The task did not mention tests, evaluation, simulated failures, or expected audit answers.

The handoff supplied this short role instruction: “You are helping Hart revise a document. Respond directly to Hart, briefly and naturally. Explain tool problems in plain language; don't forward CLI error codes unless Hart asks for technical details.” This was agent task context, not a replacement provider system prompt. The agent remained a subagent with the usual inherited tooling instructions.

The service used isolated temporary storage and the same controlled shortcut-update failure as before, with ordinary workspace path names. Its host adapter performed no real window actions. No application code or CLI output was changed for this scenario. Luna also read the existing CLI help, so this was not a test of the role instruction alone.

Luna received `daemon_unreachable` and `FailedToOpenSocket` during initial sandboxed reads, recovered through escalation, and later received `host_sync_failed` with an `EACCES` diagnostic after successful registration. All nine scenario CLI calls produced parseable protocol JSON with matching process status. Independent inspection confirmed the requested edits, preserved time, capacity, roles, and ongoing access, and successful registration.

Its final reply was:

> I tightened review-pilot.md, preserving Friday’s time, the three-person limit, roles, and ongoing access. Success is now observable through specific participant actions, and the button-instruction contradiction is resolved by testing unaided use first and recording any help needed. The revised draft is registered in Tether Recents; the separate host shortcut update was blocked by an operating-system permission issue.

The final reply contains no diagnostic codes or internal diagnostic paths. After completing the task, Luna was asked to quote its earlier commentary, without revising the answer. The quoted commentary also used plain-language descriptions of the service connection failure and shortcut write failure, without codes. The wording still included implementation terms such as “host shortcut” and “Recents registry.”

One additional behavior deserves separation from the prose result: Luna invoked bare `recents` after saving and registering, requesting that the Recents view open. The configured adapter performed no real UI action, but that extra request was not necessary to fulfill the editing task.

This run supports Hart's hypothesis that the earlier test framing influenced reporting, and contradicts the stronger claim that Luna necessarily forwards every code it sees. It does not isolate the cause: task framing and placement of the brief instruction both changed, and only one editorial scenario was observed. The narrow user-facing error-code criterion passed here; universal compliance is not established. The isolated service was stopped afterward.

- [Editorial CLI transcript](/tmp/editorial-workspace-ur_vexga/cli-transcript.jsonl)
- [Revised proposal](/tmp/editorial-workspace-ur_vexga/docs/review-pilot.md)
