# Experimental phone reader

This prototype serves a registered document, with optional desktop Folio access, through a private HTTPS gateway. It permits reading, new comments and replies. It does not authorize agents, edit document bodies or expose daemon controls.

## Current review

Mobile Folio adds a themed drawer and same-tab document navigation. The new [desktop connection](#desktop-folio-on-mobile) explicitly enables shared desktop documents and conversations; existing phone installations keep their current scope until configured. Restart remains a host operation. CLI supervision and deployments are described in [Phone reader operations](phone-reader-operations.md).

## Loading and diagrams

Content-hashed application assets are compressed when the browser accepts gzip and cached privately on the phone for a day. Document responses and credentials remain uncached. The gateway buffers assets from loopback before sending them over the mobile connection and allows longer idle transfers. Unchanged connection checks preserve the editor and comment composer.

The host renders Mermaid blocks into SVG and includes them in the initial document response. SVG stays sharp when enlarged; an embedded font keeps label measurements consistent. A bounded in-memory host cache reuses unchanged diagrams. Source changes produce new previews; the phone downloads no Mermaid renderer. This pilot uses a fixed light diagram palette. Full-document snapshots still travel on document changes; this is not yet a delta-sync protocol or offline document cache.

`DiagramRenderer` is injected into the gateway. Its current source-checkout implementation uses the existing Playwright Chromium installation, with network access blocked and no session credentials in the rendering page. It starts lazily, serializes rendering, limits source/output size, and closes with the runner. A packaged release would need a different deployment arrangement for that host renderer.

## Composition

`src/remote/contracts.ts` defines the replaceable boundary: `ReaderBackend.open(documentId)` returns a connection to the existing reader resource protocol, with explicit closure. `LocalReaderBackend` resolves that persistent ID to an allowed local path and keeps upstream credentials private. A future shared database or file connector can replace this adapter; this experiment does not prescribe either.

The gateway owns the bounded browser session. `PasskeyProvider` verifies proofs; `IdentifyCaller` supplies identity from trusted transport. Neither actor labels nor text entered by a user are credentials. Browser input can itself be dictated and cannot establish keyboard approval.

Voice capture, trusted input provenance, outbound approval queues, diagram anchors and agent-runner authorization are outside this prototype. Extra provenance fields on comment JSON do not establish or persist such authority. The existing quote-anchor protocol is a compatibility constraint, not a decision about future anchors.

## Access boundary

- Reader and approval require **different dedicated HTTPS hostnames**. Ports alone do not isolate cookies. Serve each hostname exclusively for its intended surface.
- The runner binds only loopback ports 8413 (reader) and 8414 (approval). Tailscale Serve must terminate HTTPS and supply its authenticated user header. Local processes remain trusted; a forged loopback header alone still cannot satisfy the passkey check.
- Enrollment begins only in an interactive owner terminal. Its code expires after five minutes and is consumed once. Store it only in the setup page, never in a prompt.
- Login requires the enrolled passkey with user verification and binds the result to the browser that requested it. The one-use handoff is carried in POST bodies. Session cookies are Secure, HttpOnly and SameSite=Strict; sessions expire after at most one hour without renewal.
- “End all sessions” requires a passkey and closes upstream access too. Restarting the gateway loses all sessions. The public credential record persists with restricted permissions; private passkey material stays with the authenticator. Run only one process per state directory.
- The passkey protects this service's session, not other software already authorized on the host. It proves use of the enrolled authenticator with verification, not an absolute natural-person identity guarantee.

## Running

For local UI work, use [phone staging](phone-staging.md) in a Paseo browser tab. It uses disposable state and simulated sign-in.

After two private HTTPS routes and their exact owner login are available, run `bun scripts/phone-reader.ts --help` for arguments. Supply a disposable Markdown file, a new private state directory, the two origins and `--enroll` on the first run. The foreground process prints the setup page and asks the owner to type `ENROLL` before producing a setup code. Open the setup page at the Mac, enter that code and create the passkey. Then open the reader origin on the phone and verify with the enrolled passkey. Stop with Ctrl-C.

The script does not change Tailscale, start Funnel, alter tags or manage production profiles. [Tailscale Services](https://tailscale.com/docs/features/tailscale-services) can provide separate names but requires a tagged host and administrator approval; deployment must fit the existing tailnet rather than silently retag a personal machine.

## Verification

Run `bun run check`, then `bun scripts/check-phone-reader.ts`. Set `PHONE_TEST_SLOW=1` for throttled transfers. The browser check uses temporary loopback HTTPS, a virtual Chromium authenticator, a disposable document and a simulated trusted transport identity. It covers Chromium login, WebKit touch comments and drawer bounds, heartbeat stability, host-rendered diagrams and source changes, denied edits/control access, and revocation. It does not validate a live Tailscale route, physical iPhone, or real passkey. Test certificates, credentials and profiles are removed afterward.


## Desktop Folio on mobile

Run the source phone reader with `--folio-profile preview` to authorize reading and commenting on all documents currently in that desktop profile’s Folio, including Archive. Omit this option to retain the single-document pilot. `phone-reader-ctl configure` accepts the same option for new supervised installations. Existing installed configurations are not changed automatically by a code deployment.

The desktop daemon must be running a version with revocable reader sessions (`/control/session/revoke`). The adapter refuses older launch contracts; update the desktop daemon before enabling this connection. It never starts or restarts that daemon itself. The phone runner still supplies its own current browser assets, so the two surfaces share document data without requiring identical browser bundles. Enrollment and Tailscale configuration are unchanged.

The desktop adapter resolves opaque Folio IDs to paths locally and checks membership before opening; the gateway rechecks membership for scoped document requests. Each document has a distinct `/reader/d/ID/` URL, preventing another tab’s selection from changing the target of a comment. Folio supplies document titles, directory labels and conversation counts only after the existing identity and passkey checks. Revocation closes both local and desktop reader connections. The initial disposable pilot document remains available at `/reader/`.

The mobile drawer exposes Active/Archive, filtering, sorting and existing pin/conversation indicators. It does not mutate Folio membership or settings. Touch navigation, shared comments, viewport bounds, same-tab loading and revocation are covered by `bun scripts/check-phone-reader.ts`; use `PHONE_TEST_FOLIO_SCREENSHOT=/tmp/folio.png` to capture the disposable WebKit view.
