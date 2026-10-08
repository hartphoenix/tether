# Local Settings staging

Run `bun run stage:settings` and open `http://127.0.0.1:8416/`. For a Paseo service, use `exec bun scripts/settings-stage.ts`; the launcher accepts Paseo’s assigned port and local proxy URL.

The preview renders the real Settings interface against a disposable simulation. It never installs Tether, configures a tunnel, enrolls a passkey, or accesses a real profile. Agentation and React are development dependencies used only by this staging entrypoint.

## Try the flow

1. Choose **Fresh install**, then **Set up Tether Fly**. Answer the setup questions in the same tab.
2. Prepare setup, allow the simulated agent’s progress reports, then select **Run simulated installation** above the panel.
3. Select **Simulate passkey sign-in**, confirm the simulated checks, and verify setup.
4. Use **Reset to fresh install** to repeat. **Existing setup** has three file machines, including one offline, two browsers, and an unassociated Paseo client. Each mode keeps separate state.

State survives page reloads while the server runs. Restarting the server resets simulations; it preserves submitted feedback. Settings controls change only simulated state, and passwords are never retained.

## Give feedback

Activate Agentation at bottom right, select an element, and add a note. **Send Annotations** or **Send all feedback** saves notes from every staging page in this browser, grouped by page URL, to `.local/settings-stage/feedback.json` for an agent to read. Copy remains available for pasting feedback into a conversation.

Wizard questions have distinct hash URLs; installation, sign-in, verification, and completion have distinct paths. Agentation uses hash-aware storage so each page keeps independent notes. Saved annotations survive navigation, reloads, and simulation resets. Reloading staging also imports accumulated browser notes automatically. Notes on other pages do not need to be submitted one page at a time.

Run `bun run check:settings-stage` to verify both installation variants, Agentation submission and page separation, reset, history, draft recovery, sign-out, and scrolling in Chromium and WebKit.
