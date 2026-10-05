# Local phone staging

## Current review

The mobile reader now owns theme selection, including custom themes without editing controls. The staging sidebar and gateway no longer override that selection. Mobile implementations must refresh and verify the configured staging service before completion.

## Launch in Paseo

Run `bun run stage:phone:setup` once in the checkout to register the local service in `paseo.json`. It preserves other workspace settings and refuses to replace an unrelated `phone` script. Run it again to update an older staging launcher.

In this workspace's scripts, start **phone** and open its service URL in a Paseo browser tab. The equivalent CLI command is:

```sh
paseo script start phone --cwd /path/to/tether
```

Paseo assigns the port and supervises the service. Its script listing shows the browser URL:

```sh
paseo script ls --cwd /path/to/tether
```

Stop it with the script's stop button or `paseo script stop phone --cwd /path/to/tether`. Stop and start after source changes to rebuild the reader. The launcher uses `exec` so Paseo owns the staging process directly; terminal hangup triggers cleanup. Nothing is installed as a login item.

Without Paseo, run `bun run stage:phone` and open `http://127.0.0.1:8415/`. To preview another document, run `bun run stage:phone --document /absolute/path/document.md`; staging copies it before serving. The original document and its review history are untouched. Ctrl-C stops this foreground launch.

## Refresh after mobile changes

Treat updating this preview as part of each mobile implementation, including changes to shared reader code that affect mobile. After the relevant checks pass:

1. Inspect the checkout's existing `phone` service with `paseo script ls --cwd /absolute/path/to/tether`. Preserve its launcher arguments, Folio profile, and service URL; Paseo may assign a new internal port. If multiple workspaces share the checkout, use `paseo workspace ls --json`, inspect their scripts with `--workspace <workspace-id>`, and target the workspace that owns the existing staging instance. Pass that same workspace selector to stop and start. If `paseo` is absent from `PATH` on macOS, use `/Applications/Paseo.app/Contents/Resources/bin/paseo` when installed.
2. Stop and start that service with `paseo script stop phone --cwd /absolute/path/to/tether` followed by `paseo script start phone --cwd /absolute/path/to/tether`. Source and web assets are rebuilt at startup; committing is not required. For a standalone service, restart it through its existing process supervisor with the same arguments.
3. Check the service listing and request `/health` at its service URL; expect `{"service":"tether-phone-stage"}`. Verify the changed behavior in the refreshed preview, using simulated sign-in when needed. Do not create comments in a real desktop profile merely to smoke-test a toolbar.
4. Give the existing staging URL in the completion reply. Do not focus or reload the user's active tab; use a separate automated browser for verification. Report any restart or verification blocker rather than claiming staging is current.

If staging has not been configured, use the setup procedure above. Restarting disposable staging removes its sample comments and requires simulated sign-in again; desktop-profile conversations persist. Local staging refresh is authorized as part of implementation. The separately supervised live passkey reader and signed releases have their own deployment authorization; these commands do not update them.

`AGENTS.md` and this guide are tracked contributor files available in a Git clone. `scripts/build-release.ts` assembles an explicit runtime package: it copies `docs/getting-started.md` and `docs/assets`, but neither the root agent instructions nor `docs/contributing`. Keep contributor workflow instructions here, outside the shipped integration skills.

## Use the desktop library

Run `bun scripts/setup-phone-stage.ts --folio-profile preview`, then stop and start the Paseo **phone** service. The existing service URL now shows all Folio entries from that desktop profile. Comments and replies persist in the real desktop conversations, including after staging restarts. The desktop daemon must already be running with revocable-session support. Document bodies remain read-only.

This mode still uses local simulated sign-in; it does not use your production passkey or change Tailscale. The preview labels the real-data mode visibly. Theme selection uses the desktop profile’s saved preferences. Without an explicit Folio profile, staging uses disposable sample documents. For a standalone launch, use `bun run stage:phone --folio-profile preview`.

## Using the preview

Click **Simulate passkey verification** inside the phone. The reader’s paint-brush button beside Folio selects built-in and custom themes without offering theme editing. Selection persists through reloads in the reader profile; desktop-library mode uses that profile’s saved preferences. The staging sidebar has no theme override. **Custom dimensions** and **Sign-in testing** expand to show less common controls. Choose a viewport preset or enter a content width and height. **iPhone 12 mini** models a 375 × 812 screen. **Home Screen app** (the default) reserves a 50-pixel status area and 34-pixel home-indicator area, leaving a 375 × 728 reader. **Safari tab** instead uses Playwright’s 375 × 629 webpage viewport and 133 pixels of mocked Safari controls. The Safari reload button reloads the preview; other browser icons are decorative. This is a fixed visual approximation, since real Safari chrome changes with iOS version and scrolling. **Display scale** adjusts the rendered preview size without changing the reader’s CSS viewport; it is saved in this browser. The default 83% compensates for the roughly 120% magnification measured in the current Paseo setup; use 100% at normal browser scale or calibrate it for another display. Use the reader normally: select text, comment, reply, open the drawer and zoom diagrams. **Expire session** clears only staging sessions and returns the preview to sign-in. **Reload reader** keeps comments but reloads the page.

In disposable mode, comments survive reloads and simulated sign-ins while the process runs; stopping removes its document copy and review state. Desktop-profile mode keeps comments in the desktop store. The default sample includes headings, paragraphs, lists, a table, code and a diagram. No staging operation configures Tailscale or uses the production ports or state directory.

On the iPhone, use Safari’s **Share → Add to Home Screen**, leave **Open as Web App** enabled if shown, then launch the saved icon. Tether declares Apple standalone support on its reader and sign-in pages. A normal Safari tab cannot be forced to hide its controls. The mock does not reproduce iOS standalone launch or the cross-origin passkey handoff; those still need a device check. See [WebKit’s Home Screen behavior](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#every-site-can-be-a-web-app-on-ios-and-ipados).

## Fidelity and checks

The iframe supplies a real CSS viewport, so wrapping, narrow layouts, fixed controls, drawer bounds, fonts, comment UI and diagram behavior come from the same reader code as the phone. The mini’s mocked status and Safari bars sit inside its full-screen dimensions and outside the webpage viewport. Other presets remain content-only previews. Local assets are uncached so development changes appear after restarting.

Paseo renders with its desktop Chromium engine. Native iOS text selection, the software keyboard, safe-area insets, dynamic browser chrome, device pixel ratio, touch media queries and Safari-specific rendering are not reproduced. Use `bun scripts/check-phone-reader.ts` for automated mobile WebKit/touch coverage and a physical phone for those remaining behaviors. This preview also replaces TLS, Tailscale identity and WebAuthn with an explicit local-only sign-in simulation; production authentication remains unchanged.

`bun scripts/check-phone-stage.ts` verifies the staging path: simulated login through the gateway, reader loading, viewport dimensions, diagrams, commenting, session expiry recovery and request boundaries. The stage binds loopback, validates its direct/Paseo host and mutation origins, disallows enrollment and serves only its copied document and disposable Folio samples.


## Rendering and code-color audit

Measured 2026-10-03 against the phone gateway in an isolated test profile, with a real virtual-passkey flow. These are Mac Chromium measurements with 4× browser CPU throttling and local HTTPS, not iPhone 12 mini or cellular benchmarks. The fixture has twelve JavaScript blocks of twenty lines each, plus one three-node Mermaid diagram. Timings start at reader navigation, excluding passkey enrollment/verification; bytes cover observed reader resources, excluding navigation HTML and auth. Staging disables browser caching, so the production gateway test—not the staging tab—was used for cache measurements.

| Scenario | Reader ready | Reader resource transfer | What happens |
| --- | ---: | ---: | --- |
| First-ever browser load | 1.79 s | 3.17 MB | JS/CSS download, language loading, editor construction, first host diagram render |
| Returning browser, first load of a different document | 0.38 s | 44.3 KB | JS/CSS reused from browser cache; document fetched, new diagram rendered on the warm host |
| Same-document reload | 0.55 s | 47.8 KB | JS/CSS reused; document fetched; SVG reused from host cache; browser views reconstructed |

These are illustrative runs, not percentiles or a comparison proving new documents faster than reloads. The reload includes comments created during the test. A deployment with changed asset hashes, expired/evicted cache, or another origin makes a returning visit cold again. Stable hashed assets have a private one-day cache lifetime; document responses are not cached.

### Mermaid implementation and cost

- The Mac renderer now uses the same palette-to-Mermaid mapping as desktop. The phone receives SVGs, never the Mermaid/layout-engine download. Desktop's palette behavior is preserved by extracting its existing mapping into a shared helper.
- Initial previews arrive with the selected palette. A theme change sends one authenticated batch request for the authorized document; repeated blocks share that request. Unchanged preference polling does not request or render diagrams again. Stale theme responses cannot overwrite the current preview.
- The host cache keys on source plus palette, bounded to 32 entries and 16 MiB. The browser retains up to four theme batches per document. Rendering remains limited to 32 diagrams, 50 KiB source per diagram and 2 MiB per SVG; total SVG content is now capped at 4 MiB per response, with over-budget previews unavailable rather than expanding the payload indefinitely.
- For the three-node diagram: first host render including browser startup was 674 ms; a new palette on the warm host took 24 ms; cache hits rounded to 0 ms. The SVG was 23.7 KB, including its measuring font. Diagram JSON currently travels uncompressed; an isolated gzip measurement was 11.6 KB per SVG, not its current transfer size.
- The fixed embedded DM Mono font remains for host/phone label-metric consistency; palette inheritance does not introduce font downloads or theme-font relayout on the phone. Large SVGs still cost browser DOM/layout work: these small-fixture results do not establish worst-case device performance.

### Code-block coloring audit

Crepe's top-level defaults supply CodeMirror language definitions and One Dark syntax highlighting, even though the lower-level feature defaults to an empty language list. Languages load on demand and reuse their loaded support. The measured JavaScript blocks had One Dark token colors; theme CSS changes surfaces, base text, font and selection, but does not retheme those tokens.

This creates a visual mismatch in light themes. Against Tether Light's code surface, sampled One Dark token colors have approximately 1.46–3.07:1 contrast. Keeping a syntax highlighter on the phone is not itself the main measured performance problem.

CodeMirror views initialize near the viewport (200-pixel margin), with delayed offscreen teardown after five seconds. Only three of thirteen code blocks had active views at the measured ready point. Reloading reconstructs visible views and reparses their code, while language assets can remain in the HTTP cache. Scrolling can incur additional view construction; the Chromium/WebKit lifecycle check covers stable teardown/remount, not battery use or worst-case long-code parsing.

### Recommendations for review — not implemented

1. **Fix mobile syntax-token contrast using theme-aware CodeMirror highlight styles.** This can use theme CSS variables and retain the existing lazy language loaders; it does not require server-side syntax highlighting or additional per-block requests.
2. **Reduce cold-load font transfer before redesigning highlighting.** The observed stylesheet transferred 2.31 MB compressed and decoded to 3.37 MB; approximately 3.22 MB of its source consists of 126 embedded data URLs. Extracting/subsetting fonts or loading only the selected theme's fonts is the main transfer opportunity. JS added about 0.81 MB compressed. A mobile-specific asset path would preserve desktop behavior but needs font/layout regression checks.
3. **Back off idle mobile preference polling.** Existing code polls about twice per second in the foreground and every five seconds when hidden. Theme-aware diagrams add no polling, but the existing frequency is a more persistent request cost than occasional theme changes. This is a separate mobile-only change.
4. **Keep host-side Mermaid rendering and current lazy code views.** Consider compression for document/diagram JSON when diagram payloads become material; do not introduce per-code-block server requests. Validate on the actual iPhone and a constrained connection before making broader performance claims or replacing CodeMirror.

Reproduce the representative workload with `PHONE_TEST_PROFILE=1 bun scripts/check-phone-reader.ts`; `bun scripts/check-phone-stage.ts` checks every built-in palette, batched requests and absence of Mermaid downloads. `bun scripts/check-code-block-lifecycle.ts` checks virtualized code/diagram lifecycle in Chromium and WebKit.
