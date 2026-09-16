# Tether security design audit

Original audit: 2026-09-11, working tree at `9a99e0e` · Priority revision: 2026-09-15, `main` at `673f9c3` · macOS / Apple Silicon

Finish the inexpensive boundary fixes, then make the complete update path a release gate: discover, authenticate, install, reconnect, and recover without losing work. Validate the supported installation and editing workflows before publication. Keep broader lifecycle, performance, and isolation redesigns out of that critical path unless testing reveals a blocker.

This order supersedes the original lifecycle-first recommendations and the September 13 release-standard addendum. The evidence below remains a dated record, not a claim that every original defect is still present. The September 15 revision checks current source and existing verification records; it does not repeat the original measurements or certify a release.

## Recommended execution order

### 1. Close bounded gaps first

Keep this pass short; do not delay the update work to finish a general hardening program.

| Recommendation | Current state and finish line |
| --- | --- |
| Add an expected-Host check and a consistent referrer policy | The HTTP handler still has no explicit Host allowlist. Reject unexpected authorities before routing; retain bearer/cookie and Origin checks. Apply a no-referrer policy to app pages. Test ordinary launches, linked documents, and the supported embedded hosts. Neither change should require user configuration. |
| Make setup diagnose the execution permissions agents actually need | The misleading startup-lock error is fixed. The remaining integration task is to check profile-state access and local-service connectivity from the supported agent environment, identify a blocked layer accurately, and document the minimum permission change. Verify registration from a fresh session. Never silently broaden an agent's permissions or treat restarting Tether as a sandbox repair. |
| Make release requirements consistent | Reconcile the older optional-signing wording in the product plan and release guide with the authenticated-update requirement below. Distinguish update signatures from optional Apple Developer ID signing/notarization. Document how to report a problem and how a patch is built and delivered; keep instructions short. |

Already implemented: startup failures retain filesystem/child-process evidence; only actual lock contention takes the contention path; CLI results separate completed registration from host failures; routine unsupported host status no longer crowds success output; the bundled agent skill guides plain-language reporting. Preserve these changes and their tests rather than scheduling them again. See [[cli-error-audit-2026-09-13.md|CLI error audit]] and [[cli-live-audit-2026-09-13.md|Live CLI verification]]. A successful fresh-shell test is evidence for that setup, not proof that all supported agent configurations work.

### 2. Complete and prove the update path before public release

This is the main unfinished requirement. Extend the existing versioned installer, backup, update service, and notification UI; do not replace them without a concrete need.

| Part | Existing foundation / remaining requirement | Acceptance evidence |
| --- | --- | --- |
| Discover a patch | Managed Folio views already check automatically, throttled to six hours. Reader-only use has no notice, and failed checks are silent. Cover reader-only sessions, offer an explicit check, and record the last successful check separately from attempts. Keep brief offline periods quiet; make prolonged inability to check visible without blocking editing. | An installed older build discovers a newer candidate in Folio and in a reader-only session; dismissal, offline use, retry, and reconnection behave predictably. |
| Authenticate before execution | The installer checks an archive against a checksum from the same release channel, then runs the downloaded Bun runtime. That detects corruption but does not protect against replacement of both assets. Use a maintained verification design with a trust root already installed in the client, signed artifact/version/platform metadata, and separately protected signing authority. Verify before running any downloaded runtime or installer, and before extraction where supported. | Modified archives, missing/invalid signatures, wrong platform/version, and rollback attempts fail before candidate code runs or the active installation changes. Exercise key rotation and document recovery from key loss/compromise. Define stale-metadata handling without disabling offline editing. |
| Establish initial trust | A verifier and key fetched from the same compromised channel do not independently authenticate a first install. Specify the bootstrap trust assumption and distribution method alongside the updater design. | A fresh installation follows the documented trust path; the claimed protection against hosting compromise matches what is actually verified. |
| Install and reconnect | Backup, versioned releases, switching the active release, finishing in-flight requests before service shutdown/restart, and Folio reload already exist. Prove them together using two packaged versions and the actual release/download mechanism. Include saved content, unsaved drafts, private conversations, and existing views. | Upgrade from the older version through the UI and CLI; verify running version, data, drafts, and reconnection. A repeat invocation is safe and an interrupted attempt has a clear recoverable state. |
| Recover safely | Older release directories and private-state backups already exist. Recovery must account for whether a new runtime has migrated the database. | Interrupt download, verification, installation, and new-runtime startup. Recover without losing the backup or running an old executable against an incompatible database. Restore a backup into an isolated profile and verify its contents. |

Notification plus one-click verified installation is sufficient for the first release. Unattended installation can wait. A normal service restart is not a software update, and a successful local archive install is not proof of patch delivery.

[Sparkle](https://sparkle-project.github.io/documentation/) demonstrates signed archives, embedded public keys, and protected signing keys; it is not assumed to be a drop-in framework for this Bun package. [The Update Framework](https://theupdateframework.io/docs/overview/) provides a model for authenticated metadata and compromise recovery. Choose a maintained implementation suited to the packaging; avoid designing a new cryptographic protocol. Merely placing a signing key in the same compromised publishing workflow does not establish independent signing authority.

Current code: [installer](../scripts/install.sh), [update service](../src/server/updates.ts), [notice UI](../src/web/update-notice.ts). Existing candidate checks are documented in [[release.md|Release and recovery]]; they are a foundation, not evidence that the authentication and delivery gaps above are closed.

### 3. Pass a bounded release acceptance check

Run this against the packaged build and only the browsers, hosts, architectures, and agent integrations being advertised. Fix a demonstrated failure or narrow the support claim.

| Area | Required result |
| --- | --- |
| Browser-to-local-service boundary | Missing/wrong credentials, unexpected Host/Origin, replayed tickets, and cross-view requests cannot acquire unintended read/write authority. Test crafted Markdown, comments, links, and imports, especially native-open entry points. Resolve reachable high-impact flaws before release. |
| Browser hardening | Add and test an appropriate CSP and framing policy against the editor's actual scripts/styles and supported host embedding. State the external-image policy explicitly and verify requests in a live browser. Do not call this a trivial header-only change or claim document cookies isolate hostile same-origin script. |
| Fresh install and return path | A fresh account can install, edit, complete a human–agent review, register a document, and return after restart/sleep/reboot. Existing drafts and private conversations survive. Implement the requested occupied-port recovery: try the saved port first, select another loopback port only on address contention, and provide an authorized relaunch/reconnection path that preserves recoverable drafts and conversations. Test unavailable-host failures too; recovery must be accurate and preserve work, even where an explicit relaunch is necessary. |
| Data recovery | Backup and isolated restore preserve private history and recovery records. Explain that external Markdown needs its own backup. Online/automatic backup is not required to prove the existing recovery path. |
| Release operations | Verify account protection, restricted publishing/signing access, locked builds, dependency advisory review, packaged licenses, and a documented patch procedure. Publish only tested support claims. Run the full repository and package/install checks and retain their evidence. |

A private vulnerability-reporting route is a small recommended improvement; the existing product plan treats it as optional. Do not claim one exists until configured. Apple Developer ID signing/notarization remains a separate investment unless an observed installation restriction makes it necessary for the promised experience. Public publication still requires Hart's approval; this audit revision authorizes no release or account changes.

### 4. Defer broader improvements unless acceptance testing makes them necessary

| Later work | Reason to keep it outside the initial release path |
| --- | --- |
| Generalized automatic view reconnection and longer-lived host bridges | Complete recovery designs span listener identity, existing tabs, drafts, and host credentials. The explicitly requested occupied-port fix remains in release acceptance above; broader automation can follow a tested recovery path. |
| Lazy view restoration, session reclamation, and cheaper presence polling | Useful performance work, but current measurements do not establish a release-blocking resource problem. Never reclaim unsaved drafts or revoke document access merely because a lease expires. |
| Online/scheduled backups | Valuable convenience after backup/restore correctness is demonstrated; local automatic copies still do not protect against every device failure. |
| Capability-based host compatibility and more host coverage | Preserve tested support and explicit unsupported results first. Expand after verifying equivalent operations and authorization boundaries. |
| OS-enforced process containment, per-agent authority, and session-management redesign | These change the trust model and need their own design. Current daemon/updater code runs with the OS user's authority; application cookies and prompts do not contain a fully compromised process. |
| Durable registration intake while the daemon is unavailable | Add only if a supported workflow still needs it after setup/lifecycle fixes. Never report queued work as registered or introduce a second uncontrolled SQLite writer. |

Keep loopback binding, authentication, scoped views, revision checks, atomic writes, private conversation storage, and operation receipts. The existing evidence does not justify removing them to reduce startup friction. Prioritize exposed boundaries and concrete failure consequences rather than inferring safety from one user and no reported attacks.

## Original audit evidence — 2026-09-11

The following observations and measurements describe the original checkout. Startup/CLI findings explicitly marked superseded are retained to explain the failure and subsequent correction; other observations require revalidation before implementation. Hart's three reported registration failures established a repeated workflow problem, but the original audit did not determine their cause or a population-wide failure rate.

### Evidence and limits

Reviewed daemon startup/configuration, HTTP authorization, document reads/writes and grants, persistent views/drafts, Folio registration, browser/Wave/cmux adapters and bridges, private SQLite storage, agent read contracts, rendering, installer/update and backup paths, and relevant tests. Existing work was preserved; no application implementation changed. External sources establish attack mechanisms and analogous vulnerabilities, not Tether incident rates.

Measurements used temporary profiles and a synthetic 10,366-byte Markdown file; no live service was restarted. These are warm-filesystem, single-machine microbenchmarks, not packaged-release or human-interaction measurements. The probe used direct TypeScript function calls and loopback HTTP; timings exclude a fresh CLI process, model latency, browser rendering, and actual host placement. The source-checkout daemon builds its web assets at startup. The check suite was also running during this measurement window, so contention and warmed caches can affect results.

| Measurement | Observed result | Interpretation |
| --- | --- | --- |
| Fresh temporary-profile daemon startup | 111.57 ms, one run | Normal startup was fast in this environment; not a cold-disk guarantee. |
| Restart with stored reader session | 103.94 ms, one run; old cookie returned HTTP 200 | Persistence works for the tested same-port, unchanged-path case. |
| Ensure already-running daemon | Median 0.18 ms; p95 0.40 ms; 20 calls | Discovery/health overhead was small. |
| Authenticated document read | Median 1.07 ms; p95 5.75 ms; 20 calls | Includes discovery, file checks, hashing, private state and HTTP; not authentication alone. |
| Folio registration | Median 0.78 ms; p95 14.72 ms; 20 calls | Repeated same-file registration, no host target; not a Wave sync benchmark. |
| Ordinary file read | Median 0.02 ms; p95 0.04 ms; 100 calls | Warm small-file baseline. |
| Safe file read | Median 0.14 ms; p95 0.22 ms; 100 calls | About 7× relative cost, but only 0.12 ms extra at the medians. |
| Detached daemon resident memory | 308,768 KiB, about 302 MiB; one sample | Whole process including Bun, web build and app state; cannot attribute this to security. |
| Missing browser cookie / wrong-origin write | HTTP 401 / 403 | Tested access checks rejected these requests. |
| Saved port occupied by a temporary listener | Startup raised `EADDRINUSE` | No alternative-port recovery in `startDaemon`. |
| Startup lock changed to mode 0644 | “Another Tether daemon appears to be starting but did not become healthy.” | Reproduced misleading diagnosis; probe shortened polling to two attempts, 203.46 ms. |

The full check initially produced 238 passes, 50 failures and one error in the restricted execution environment, including loopback bind errors reported as “port 0 in use.” With loopback permission, **all 288 tests passed**, followed by TypeScript checking and the web build. This is direct evidence that an execution sandbox can generate misleading apparent daemon failures; it is not proof that Hart's previous failures had that cause. Tests do not establish actual sleep/reboot behavior, browser cookie restoration, live host compatibility, or absence of exploitable vulnerabilities.

Reproduction materials from this session: `/tmp/tether-security-probe.ts`, `/tmp/tether-security-measurements.json`, `/tmp/tether-security-check.log`, and `/tmp/tether-security-check-network.log`. Temporary profiles were removed. These scratch materials may not survive system cleanup; the results above are the durable record.

### What the security boundary actually is

The trusted principal is effectively **the local OS account with access to the control credential**, not a project, agent, or named author. The CLI reads a private bearer credential and asks the daemon to act. An explicit path-scoped request calls `service.open(path)` automatically; there is no separate user approval database for routine agent reads/writes. `actor` supplies attribution, not authenticated identity. Browser requests use separate, document-scoped session cookies; Folio has its own broader session.

The daemon is also a shared writer and state owner. It serializes operations, coordinates SQLite, publishes Folio changes, and serves all views. Persistence exists partly to improve continuity and avoid one process per document. Replacing it with per-command processes would still require database/write coordination and some service to host the UI. Simply removing it would not remove those responsibilities.

There are four distinct sources of what can look like a “permission problem”:

| Layer | Actual restriction | Who can resolve it |
| --- | --- | --- |
| OS / agent execution sandbox | Cannot write profile state, bind/connect loopback, or access a host socket | Product installation and agent integration must supply an allowed execution path; Tether cannot override the OS. |
| Tether browser authorization | Cookie absent, session unknown, or stored path identity changed | Usually a fresh authorized launch or Locate/reopen action; should preserve draft recovery. |
| Shared writer / startup coordination | Another writer, unsafe lock, or failed startup | Usually internal retry/diagnosis, not a user policy decision. |
| Host capability | Wave credential or cmux signed capability unavailable; incompatible build or missing target | Reconnect through the host or give a precise host launch action. |

Code: [lifecycle](../src/server/lifecycle.ts), [control routes and sessions](../src/server/server.ts), [document service](../src/documents/document-service.ts), [view store](../src/server/view-store.ts).

### Threats addressed, and the value of each protection

“Frequency unknown” below means no defensible Tether per-user/year estimate is available. An attack being technically possible or having a CVE is not evidence that it commonly succeeds.

| Threat / failure | Present defense | Frequency and exposure | Consequence if successful | Assessment |
| --- | --- | --- | --- | --- |
| A remote machine directly invokes local file APIs | Bind to `127.0.0.1`; control bearer authentication | Network exposure would be continuous while listening if bound publicly; attempted/successful attacks on Tether unknown | Disclosure or modification of documents/private reviews reachable through the API | Keep. Very low normal interaction cost. |
| A malicious website reaches the user's local service | Browser cookies, SameSite=Strict, state-change Origin checks, control bearer; no permissive CORS response in reviewed routes | Browsing while local tools run is ordinary; successful exploitation rate unknown | Read/write within acquired authority; sensitive Markdown may contain credentials or business material | Keep. Localhost alone is insufficient. Vite has a documented analogous vulnerability. |
| A copied launch URL or leaked page URL becomes reusable authorization | Random 256-bit one-use tickets, 30-second expiry, HttpOnly scoped cookie; ticket redirects use no-referrer | Accidental URL sharing/history is plausible; actual leaks unknown | A consumed ticket grants that view's authority; URL alone after exchange is insufficient | Keep one-use exchange; reconsider the narrow time window independently. |
| One browser view accidentally operates on another file | Session-to-file mapping and private cookie verifier | Multiple simultaneous views are normal; wrong-target bugs are plausible, unmeasured | Wrong document edited or disclosed | Keep explicit mapping. It is also a correctness aid. |
| A previously authorized path is redirected through a symlink or replaced parent | Canonical paths, parent device/inode checks, no-follow reads, repeated identity checks | Ordinary file replacement is common and supported; parent relocation/recreation can be legitimate. Malicious path substitution rate unknown | Access to an unintended file; wrong-target overwrite | Retain safe reads/writes; improve recovery for legitimate moves. Parent pinning is a narrower, more debatable tradeoff than file validation itself. |
| Two views or agents overwrite each other's changes | Per-path queue, cross-profile advisory lock, expected body revision, atomic replace and syncing | Concurrent editing is intrinsic to this app, though conflict incidence is unmeasured | Lost prose, inconsistent state, recovery effort | High value. These protect against everyday accidents as well as adversarial races. |
| An uncertain request is repeated | Annotation operation IDs and transactionally stored receipts; conflict checks | Timeouts/retries are normal distributed-process events | Duplicate comments, wrong resolution/acknowledgement, repeated mutations | Keep the guarantees; automate IDs and retry handling where possible. They do not universally cover body saves/Folio operations. |
| Sharing Markdown accidentally includes private conversations | Private SQLite separated from Markdown; deliberate export | Sharing/versioning Markdown is an ordinary workflow | Private discussions published with the file | Strong privacy value. Creates a separate backup obligation. |
| Other OS accounts read stored state, or child processes inherit unrelated credentials | Private directories/files and environment allowlists; host credentials isolated in bridge memory/environment | Multi-account exposure depends on machine usage; incidental environment inheritance occurs whenever processes spawn | Private-history disclosure or host/account credential misuse | Keep. Does not stop software running as the same user. |
| Huge or malformed inputs exhaust memory or corrupt protocol state | Byte limits, schema validation, bounded agent reads and package validation | Large generated content is plausible; deliberate abuse rate unknown | Crashes, unusable UI, memory pressure | Keep bounds. Per-request limits do not bound cumulative sessions/history or concurrent work. |
| Damaged or wrong release archive is installed | HTTPS, SHA-256 comparison, archive-entry checks, versioned installation | Downloads/updates are routine; corruption frequency unknown | Failed installation or unintended executable content | Keep. A checksum fetched from the same compromised release account does not authenticate an independent publisher. |

The [Vite maintainer advisory](https://github.com/vitejs/vite/security/advisories/GHSA-vg6x-rcgg-rjx6) documents website-to-local-server data access through CORS/WebSocket/Host validation defects, including local-only operation. It demonstrates that this threat class is real; it supplies no incident probability for Tether, which does not use Vite as its server. [OWASP's CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) supports retaining origin validation and layered browser defenses.

### Important risks outside, or incompletely inside, the model

| Risk | Present gap and scope | Frequency / damage judgment |
| --- | --- | --- |
| An authorized agent makes a destructive mistake or follows hostile instructions in a document/comment | Control authorization is not per-project or per-agent. Revision checks verify freshness, not whether a requested edit is sensible. A daemon with broader filesystem access can act beyond a caller's own sandbox if that caller can reach control. | Reading untrusted prose and making edits are routine; successful prompt injection and serious error rates unknown. Potentially high damage across accessible files/reviews. Tether does not authenticate `actor` as a human. |
| Malware or a malicious dependency runs as the user | It can generally read the control token, private SQLite and source documents, or alter application code, subject to OS restrictions. Daemon and bridge controls are not a same-user malware sandbox. | Tether-specific frequency unknown; potentially all private data or account-level compromise. Additional document prompts would provide little protection once this boundary is lost. |
| Private-history loss, accidental deletion, disk failure or ransomware | SQLite is separate from the repository. Backup exists but requires stopping the app; it does not back up arbitrary external Markdown. No routine automatic backup mechanism was found in these paths. Local update backups share the machine's failure domain. | Deletion and device/storage failures are ordinary hazards over product lifetime; rate unknown. Up to all unbacked conversations and drafts can be irrecoverable. |
| Browser script injection and excessive authority after page compromise | Comment renderer safely renders HTML as text and avoids remote image loads. Main editor relies on Milkdown and dependencies. Actual reader response has no CSP, frame restriction, or referrer-policy header. All views share one origin; cookie paths are not script-origin isolation. Reader `/api/open` accepts arbitrary local targets without checking that a clicked link exists in the document. | No working XSS exploit demonstrated. Conditional damage includes current-document mutation, preferences and native-open actions; a compromised Folio has broader operations. Do not describe document cookies as a complete hostile-script sandbox. |
| Remote image tracking / unintended requests | Main editor image rendering permits source URLs; no app-level remote-image consent or network allowlist was found. Comments are more restrictive. | Loading a supplied remote image is a routine rendering behavior. A tracking URL can reveal that this document was opened, timing and network address. This does not itself prove arbitrary local-file exfiltration. Live browser traffic was not tested. |
| Stolen session or local port impersonation | Persisted verifiers restore sessions, without an expiry/revocation UI in the reviewed view-store path. Cookies lack port isolation; stable-port recovery does not authenticate the listening server to an old tab. | Requires local listener control or a credential leak; incidence unknown. A replaced local server may receive a reconnecting tab's cookie and can potentially serve hostile app code. This is not an unauthenticated remote exploit demonstrated here. |
| Resource accumulation / denial of service | Views are eagerly restored at startup; inactive leases do not remove sessions, and no general view pruning was found. Each launch creates another stored view. Browser lease processing reads the body and derives annotation state. | Reopening files and accruing history are ordinary. Large histories can increase startup work and runtime cost; growth measured structurally, not with a large-profile load test. |
| Compromised distribution account or dependency | Installer trusts archive and checksum from the same release channel; no independent mandatory signing verification. Source checkout runs a large dependency graph. | Frequency unknown; very high conditional damage because installed code runs as the user. The current recommendation above requires authenticated updates; Apple Developer ID signing/notarization remains a separate decision. |
| External editor races and multi-store consistency | Advisory locks coordinate Tether, not other editors. Final check/rename has a remaining external-writer race; Markdown and SQLite are not one atomic transaction. | Concurrent editors are plausible; exact race probability unknown. Local lost edits or mismatched history remain possible despite substantial safeguards. |

[OWASP's prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) treats external documents and tool output as possible indirect instruction carriers. This risk belongs jointly to the agent harness and Tether's integration; adding another daemon credential does not solve it. [CISA's ransomware guide](https://www.cisa.gov/stopransomware/ransomware-guide) recommends protected backups; ordinary local copies do not cover all device or malware failures. [RFC 6265, sections 8.5–8.6](https://www.rfc-editor.org/rfc/rfc6265.html) explains cookie port/path isolation limitations.

The HTTP handler also lacks an explicit Host allowlist. Existing bearer and cookie checks still matter: missing Host validation alone does **not** establish an arbitrary-read vulnerability here. A strict expected-host check is inexpensive defense in depth; it should not become a new user-facing setup requirement.

### Where the operational cost comes from

**Historical startup diagnosis — superseded by the CLI fixes merged in `673f9c3`.** At the original audit, `ensureDaemon` detached the child with stdout/stderr ignored, did not report its exit status, and polled for discovery. It treated every startup-lock acquisition error as contention. A denied filesystem operation, unsafe lock, native locking failure or genuine competing launcher can therefore converge on the same misleading text. `statusDaemon` also collapses missing discovery, dead process, timeout and identity mismatch into `running: false`.

The default contender loop performs 100 attempts with 100 ms sleeps: roughly 10 seconds when checks fail immediately, or about 40 seconds if each health request reaches its 300 ms timeout, plus filesystem/scheduling time. A launched child gets 200 attempts: roughly 20–80 seconds under the same assumptions. These are code-derived timing ranges, not hard upper bounds. They are orders of magnitude above the measured ~0.1-second successful startup. A plain startup `Error` becomes `command_failed`; it has no structured cause, repair action, or explicit pre-operation outcome.

**Stable-port persistence trades simpler resumption for a hard startup dependency.** `startDaemon` reads `listener.json` and binds that port without an `EADDRINUSE` fallback. Preserving it is useful because open pages point there. The absent recovery path is not a security requirement. Blindly choosing a new port would start the service but strand existing views; a complete design needs both startup recovery and a way to reopen/reconnect them.

**Wave loses callback capability after five minutes without bridge requests.** Reader heartbeats go to the main daemon and do not renew that bridge. An otherwise active reader can outlive its callback service. Reopening from a Wave terminal/widget recreates it, but that recovery leaks implementation details into normal use. Retaining a narrow credential-bearing bridge for the host session would extend credential lifetime; that is a bounded tradeoff, not a reason to persist the Wave credential to disk. Bridge HTTP requests time out at two seconds, while host subprocesses lack equivalent explicit deadlines; a caller timeout does not prove the host action stopped.

**cmux has two readiness paths and an exact-build gate.** Direct CLI access and detached callbacks depend on different capability availability. The current gate accepts only version `0.64.22`, build `102`, commit `ddd4a01bc`; a different build is rejected regardless of whether the required operations still work. This mainly enforces a verified compatibility assumption, not a general security boundary. Its maintenance cost recurs on host upgrades. The bridge supports a 30-second prepared restart window and checks daemon identity every ten seconds; unprepared failure/reboot still needs a valid host bootstrap. Relaxing build checks should follow capability verification, not disabling host authorization.

**Historical registration/host coupling — CLI reporting superseded by `673f9c3`.** At the original audit, the CLI sent `/control/folio/add` without a host target. It therefore has no Wave placement prerequisite and usually reports host sync as unsupported; it does not fulfill README's active-host-sync promise on this path. Registration still requires a working daemon. Where a target is supplied, `RecentsService` correctly commits and publishes registry changes separately from host work and returns a distinct sync status, although the caller still waits for synchronization. This is useful existing separation to extend, not evidence that every registration failure is a host-credential problem.

**Private state and continuous availability have carrying costs.** The daemon remains while stored sessions exist; absence of leases does not stop it. That supports resumption but retains process memory and session metadata. One main daemon plus Wave and cmux bridges can mean three Bun processes, excluding clients and host subprocesses. Only the main process was measured. The web build contained 1,281 modules, 3.49 MB JavaScript, 3.36 MB CSS and a 0.66 MB icon, as reported by Bun; this is substantial baseline app cost, not evidence that security consumes hundreds of megabytes.

Reader polling runs every 15 seconds: **240 lease requests per hour per awake view**, or 2,400 for ten views. Each currently invokes a full document read and annotation derivation merely to return revisions. At the fixture size that is approximately 2.49 MB of body reads per view-hour, before other work; at 1 MiB it would be 240 MiB. These are logical reads, often served from filesystem cache, not measured physical disk traffic. Folio adds a 30-second heartbeat and event stream. Auth hashing is unlikely to dominate this work; actual idle CPU, battery and webview memory were not measured.

**Agent and attention costs are dominated by recovery branches.** Normal CLI calls do not put bearer credentials into model context. Operation IDs, cursors, revision checks and progressive reads add protocol learning cost but prevent expensive duplicated work and excessive reads. Restarts discard the bounded body-diff cache (64 bodies / 32 MiB; 2 MiB maximum per body), potentially forcing context recovery. This is an app cache loss, not evidence of provider prompt-cache invalidation.

As an explicit scenario, three additional diagnostic tool calls returning 0.5–2 KiB each add 1.5–6 KiB of new tool output, roughly 400–1,500 tokens at an assumed four bytes/token, plus calls/reasoning and any repeated context. No agent billing/token telemetry was collected, so this is not a measured bill. The human cost can be abandonment of the workflow even when the underlying file is unharmed; an error about an unrelated app also displaces attention from the task the agent was doing.

Other costs include native FFI locking as a portability dependency; backup downtime; cross-filesystem move rejection; loss of draft discoverability when session restoration fails; repeated host-version maintenance; and additional branches to test. The nine lifecycle/config/view/bridge/safe-file/lock files alone total 1,370 physical lines, excluding server routes and tests. This is a maintenance surface indicator, not “1,370 lines of unnecessary security.”

### Quantitative comparison without invented incident rates

For each protection, compare its **incremental** recurring cost against its **incremental** reduction in expected loss:

`net value = (probability reduction × incident loss) − recurring operating cost`

Use a separate calculation for each control. A slow startup failure should not be charged to an inexpensive Origin comparison unless removing that comparison actually fixes it. Likewise, confidentiality loss cannot always be reduced to recovery hours; use the same unit or retain a separate severity constraint.

| Illustrative recurring cost | Assumed avoidable incident loss | Annual probability reduction needed to break even |
| --- | --- | --- |
| 12 interruptions × 5 minutes = 1 hour/year | 8 hours of recoverable lost work | 12.5 percentage points |
| Same 1 hour/year | 100 hours of lost work/recovery | 1 percentage point |
| Same 1 hour/year | 1,000 hours equivalent loss | 0.1 percentage point |

These are sensitivity examples, not Tether forecasts. The reported three incidents have no launch-count denominator, measured recovery duration or attribution. Projecting them into annual failure rates would be misleading. Low-friction controls can be justified against rare high-impact events; frequent blockers need a much stronger marginal benefit or a redesign. Here, better lifecycle handling appears capable of removing much of the friction while retaining the same security boundary, making it preferable to accepting additional attack risk.

## Preserved design constraints

The execution order at the top is the current recommendation. Registration success must mean the canonical registry changed; host placement failures remain separately actionable. OS permission failures need accurate diagnostics and a supported setup path. Recovery must preserve documents, drafts, and conversations without weakening authentication or conflict checks.
