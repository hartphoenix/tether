# CLI signal and outcome improvement plan

Date: 2026-09-13
Status: implemented and verified after independent Astra review
Checkpoint: `bc431a3`

## Intended result

Agents receive the requested result, actionable failures, and the information needed to recover safely. Successful incidental work stays quiet. Tether preserves underlying diagnostic evidence rather than replacing it with guesses, while retaining a stable application envelope and explicit completion state.

This implements the reviewed [CLI audit](cli-error-audit-2026-09-13.md) and the agreed compact registration response. No new dependencies, automatic permission changes, or host-configuration changes are required.

## 1. Compact command results

Keep protocol 1 and the existing 0/1/2 exit convention. Shape CLI results at the CLI boundary; retain existing daemon/browser DTO fields and host behavior. Add diagnostic fields upstream where needed to avoid losing evidence in host adapters or the Recents service before it reaches the CLI.

- `recents add` and `folio add`: return only `added: [{path}]` on ordinary success, without the full registry, timestamps, synchronization booleans/statuses, or internal sequence.
- Other ordinary Folio mutations: retain their requested mutation results and per-item outcomes, but omit ancillary full registry lists and host synchronization bookkeeping, including nested import registration results.
- If an applicable host update actually fails, add an actionable `warnings` array with a stable code, plain-language message, and safe underlying diagnostic. Registration remains successful. Unsupported/skipped synchronization produces no warning.
- Explicit `folio sync`, `folio list`, and status/doctor commands retain the detail they were asked to report. Partial imports retain completed/failed item results and outcome; do not conceal failures just because the envelope says `ok: true`.

Example: `{"protocol":1,"ok":true,"command":"recents.add","data":{"added":[{"path":"/tmp/example.md"}]}}`.

## 2. Small shared diagnostic representation

Add one reusable error-details helper rather than a hierarchy of wrappers. Preserve existing application codes, attach safe underlying diagnostic identity (code, syscall, relevant filesystem path, HTTP status, child exit status), and carry bounded cause chains where helpful. Do not serialize arbitrary error objects, request headers, command arguments containing credentials, launch URLs, or unlimited subprocess output. Messages must preserve useful evidence without leaking known credential-bearing URL/header forms. Redaction/truncation must be explicit where it occurs.

Use it in server error mapping, CLI formatting, filesystem validation, transport errors, and package input. Raw code identity and operational interpretation coexist: `file_access_denied` can carry `EPERM`; a request known not to have started is `not_applied`, while an interrupted write remains `outcome_unknown`.

## 3. Honest discovery and startup

Distinguish absent discovery/dead process from unreadable or malformed discovery and unreachable live service. Only absence/death authorizes a new launch; an inaccessible live service should yield an actionable reachability error with its original transport cause, rather than falling through to a misleading startup-lock error. Keep genuine lock contention retrying.

Status/doctor must distinguish a confirmed stopped daemon from one whose health cannot be determined. Stop, backup, update, and uninstall must not treat indeterminate health as stopped. Token-read failures retain their cause. Preserve automatic cold startup, stale-dead-process recovery, concurrent launch convergence, and controlled restart behavior. Initial discovery rejects a live-but-unreachable daemon without spawning; an established startup/concurrent-peer wait retries transient reachability failures and retains the last diagnostic for its terminal error.

Capture bounded, sanitized startup diagnostics and child exit status without keeping an unread pipe attached to the detached long-lived daemon. Use a private, exclusively parent-owned temporary startup directory and a structured failure report path passed to the child; cap and sanitize reports, never persist raw daemon logs, and remove the directory on success/failure/timeout. A late child failure must not recreate the removed directory or replace its primary exception with a report-write failure. Startup code that cannot reach the reporting hook must still yield the child exit status. Test cleanup and timeout behavior.

## 4. Correct input and preference failures

Preserve `stat`/`realpath` failures in Recents validation; assign explicit codes to invalid extensions and non-files, with `not_applied` before any registration. Separate reading a package from parsing/validating it so permission, missing-input, and size errors retain their codes. Default the saved launch destination only when its file is absent; malformed/unreadable preferences report their actual problem. Read that preference only for open/recent/Folio launch/setup; unrelated commands such as registration, stop, backup, and restore must remain usable. Doctor reports invalid preference state diagnostically.

## 5. Multi-step outcome reporting

Track completed meaningful steps locally in the affected commands; avoid a generic workflow engine. On failure, retain the original command and primary error, plus completed paths/steps and truthful overall outcome.

- Open/setup: registration and setup configuration may complete before host placement fails; unused launch credentials still get cancelled. Cleanup failure must not replace the original placement error; attach it as secondary evidence if cleanup cannot be confirmed.
- Export: distinguish pre-publication failure from publication followed by failed durability confirmation; an existing output does not prove it was created by this attempt.
- Update/uninstall: report backup/completed removals and child exit status when later steps fail; do not imply rollback.
- Preserve existing receipt-based recovery for review mutations and detailed import outcomes.

## 6. Verification and documentation

Turn the two known-failure tests into ordinary passing contracts. Add focused end-to-end/fault-injection coverage for compact success, applicable-host warnings, diagnostic preservation/redaction/bounds, Recents validation, package input, invalid preferences, discovery failures, cold startup/concurrent startup, and each multi-step failure boundary changed. Validate the observed files/registry state against reported outcomes, not just response shape. Use isolated fixtures; never exercise destructive failures against the live installation.

Update README's agent contract with compact result examples, actionable warnings, partial outcomes, and diagnostic fields. Do not edit persistent agent-context/skill files without separate approval. Run the full check and inspect the final diff. Add the final plan to Tether Recents. No push or PR is requested.

## Review gate

An independent Astra reviewer checks minimality, missing outcomes, security of diagnostics, compatibility, and test adequacy. Incorporate findings and resubmit until there are no execution-blocking issues, then implement this plan. Record the review result below and verify the implementation against the accepted plan.

Review 1: Astra requested explicit preference-read scope, additive diagnostic plumbing through host adapters/service, and startup state transitions that never mistake indeterminate health for stopped. These revisions and startup-report/cleanup safeguards are incorporated above; resubmitted for execution readiness.

Review 2: Astra confirmed “Ready to execute; no remaining plan blockers.” Implementation began after that approval.

Implementation review: Astra identified remaining status/credential suppression, storage-outcome overwriting, missing JWT redaction and cmux cause text, startup timeout ownership and failure shutdown, export boundary handling, and Wave launch cleanup. The implementation addresses these with focused failure tests; final verification follows.

Final review: Astra found no remaining material blockers after the startup-publication and credential-redaction regressions were addressed. The complete check passed: 312 tests, zero failures, 1,692 assertions, TypeScript, and the browser build. The former expected failures now pass as ordinary tests. CLI result projection keeps routine synchronization and registry bookkeeping out of successful mutation responses while preserving explicit diagnostics, warnings, and partial outcomes. The checkpoint commit remains `bc431a3`; this implementation is left in the working tree and has not been pushed.
