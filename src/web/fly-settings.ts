/** Self-contained so local and shared Settings use exactly the same application. */
export function mountFlySettings(root: HTMLElement, request: (action: string, body?: unknown) => Promise<any>, localOwner: boolean) {
  let state: any, timer: ReturnType<typeof setTimeout>, disposed = false;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const element = document.createElement(tag); element.textContent = text; return element; };
  const error = node("p"); error.setAttribute("role", "status");
  const content = node("section"); root.append(content, error);
  const run = async (action: () => Promise<void>) => { error.textContent = ""; try { await action(); } catch (cause) { error.textContent = (cause as Error).message; } };
  const button = (label: string, action: () => void) => { const element = node("button", label); element.type = "button"; element.onclick = action; return element; };
  const field = (label: string, value: string, type = "text") => {
    const element = node("label", label), input = node("input"); input.type = type; input.value = value; element.append(input); return { element, input };
  };
  const action = async (name: string, body: unknown = {}) => { await request(name, body); await refresh(); };
  const prompt = (attempt: any) => {
    const destination = !state.configured || attempt.answers.access === "browser" ? "the hub" : attempt.answers.machine;
    const revision = state.sourceRevision ?? "the tested source revision supplied with this build";
    return `${attempt.answers.relocate ? `Relocate the existing Tether hub to ${attempt.answers.hub} using the prepare, release and activate procedure (pass --attempt ${attempt.id} to prepare); preserve the former hub as a file machine. Begin with an agent on the current hub and coordinate the destination before cutover.` : `Set up Tether Fly on ${destination}.`} Use https://github.com/hartphoenix/tether at ${revision}. Read docs/guide/shared-profile.md and docs/guide/fly-setup.md at that revision. Preserve the existing library and Markdown; do not create another authority. Hub: ${attempt.answers.hub}. HTTPS origin: ${state.origin ?? "establish a stable HTTPS origin on the hub first"}. Access: ${attempt.answers.access}. File machine: ${attempt.answers.machine || "browser only"}. Retained machine ID: ${attempt.answers.machineId ?? "select a new identity only for a new file machine"}. Qualify copied paths: ${attempt.answers.qualifyPaths ? "yes" : "no"}. Internet access explicitly requested: ${attempt.answers.internet ? "yes" : "no"}. Setup attempt: ${attempt.id}. Request owner approval for the scoped reporting capability; report progress automatically and poll approvals. Verify service observations before declaring completion. Use the source installer and preserve existing machine IDs when re-pairing. Additional requirements are welcome; report unsupported configurations before changing the plan.`;
  };
  const showAttempt = (attempt: any) => {
    const section = node("section"); section.append(node("h4", `Setup · ${attempt.phase}`));
    if (attempt.verification && attempt.phase === "verified") {
      section.append(node("p", "Verified: browser sign-in and file access, with the selected live checks confirmed by you."));
      content.append(section); return;
    }
    section.append(node("p", !state.configured || attempt.answers.relocate ? "Paste this into an agent session on the current hub." : `Paste this into an agent session ${attempt.answers.access === "browser" ? "on the hub" : `on ${attempt.answers.machine}`}.`));
    const text = node("textarea"); text.readOnly = true; text.value = prompt(attempt); text.rows = 5; text.setAttribute("aria-label", "Setup prompt");
    section.append(text, button("Copy prompt", () => void run(async () => { await navigator.clipboard.writeText(text.value); error.textContent = "Prompt copied."; })));
    const help = node("details"); help.append(node("summary", "No agent session yet?"), node("p", "Open an agent in the chosen machine’s existing Paseo workspace, then paste the prompt.")); section.append(help);
    if (attempt.report) section.append(node("p", `Agent report (unverified): ${attempt.report}`));
    if (attempt.contact && !attempt.contact.approved) section.append(button(`Allow progress reports from ${attempt.contact.name} (${attempt.contact.code})`, () => void run(() => action("approve-reporting", { id: attempt.id, code: attempt.contact.code }))));
    if (!attempt.contact) section.append(node("p", "Waiting for the setup agent to contact this hub."));
    section.append(button("Change answers", () => wizard(attempt)));
    if (state.configured && !localOwner) {
      const machines = node("select"); machines.setAttribute("aria-label", "File machine to verify");
      const choose = node("option", "Choose this setup’s file machine"); choose.value = ""; machines.append(choose);
      for (const machine of state.machines) { const option = node("option", machine.name); option.value = machine.id; machines.append(option); }
      machines.value = attempt.answers.machineId ?? "";
      const documents = node("select"); documents.setAttribute("aria-label", "Document to verify");
      const clients = node("select"); clients.setAttribute("aria-label", "Paseo client to verify");
      const choices = () => {
        documents.replaceChildren(); clients.replaceChildren();
        for (const document of state.verificationDocuments ?? []) if (attempt.answers.access === "browser" || document.machineId === machines.value) { const option = node("option", document.path); option.value = document.id; documents.append(option); }
        for (const client of state.clients.filter((client: any) => client.kind === "agent" && client.revokedAt === null && client.machineId === machines.value)) { const option = node("option", client.name); option.value = client.id; clients.append(option); }
      };
      machines.onchange = choices; choices();
      const native = field("I verified the native sidebar, sign-in, notice, edit/review workflow, theme and tab restoration.", "", "checkbox");
      const internet = field("I verified access from a browser outside the private network.", "", "checkbox");
      if (attempt.answers.access === "paseo") section.append(machines);
      section.append(documents);
      if (attempt.answers.access === "paseo") section.append(clients, native.element);
      if (attempt.answers.internet) section.append(internet.element);
      section.append(button("Verify setup", () => void run(() => action("verify-attempt", { id: attempt.id, machineId: machines.value, documentId: documents.value, clientId: clients.value, nativeConfirmed: native.input.checked, internetConfirmed: internet.input.checked }))));
    } else if (state.origin) {
      const link = node("a", "Finish verification in hub Settings"); link.href = state.origin + "/settings/"; link.target = "tether-settings-verify"; section.append(link);
    }
    content.append(section);
  };
  const wizard = (previous?: any, relocate = false) => {
    clearTimeout(timer);
    const draftKey = "tether.fly.draft";
    let answers = previous?.answers ?? { hub: state.machines?.find((machine: any) => machine.id === state.localMachineId)?.name ?? "This computer", machine: "", access: "paseo", qualifyPaths: false, internet: false };
    if (!previous && !relocate) try { const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null"); if (saved) answers = { ...answers, ...saved }; } catch {}
    if (relocate) answers = { ...answers, relocate: true, hub: "" };
    let step = 0;
    const questions = () => [
      { key: "hub", title: "Which computer should be Tether’s hub?" },
      { key: "access", title: "Where will you use Tether?", options: [["paseo", "Paseo on a file machine"], ["browser", "Browser only"]] },
      ...(answers.access === "browser" ? [] : [{ key: "machine", title: "Which computer’s files do you want to connect?" }, { key: "qualifyPaths", title: "Include this machine’s name when copying its file paths?", options: [[false, "No"], [true, "Yes"]] }]),
      { key: "internet", title: "Allow browser access from outside your private network?", options: [[false, "No"], [true, "Yes, through HTTPS"]] },
    ];
    const render = () => {
      const list = questions(), question = list[Math.min(step, list.length - 1)]!;
      content.replaceChildren(node("p", "Tether Fly lets you collaborate on docs with agents running on remote computers."), node("h4", question.title));
      const progress = node("p", list.map((_, index) => index === step ? "●" : "○").join(" ")); progress.setAttribute("aria-label", `Question ${step + 1} of ${list.length}`); content.append(progress);
      const save = (value: unknown) => { answers[question.key] = value; try { localStorage.setItem(draftKey, JSON.stringify(answers)); } catch {} };
      if (question.key === "machine" && state.machines?.length) {
        const select = node("select"); select.setAttribute("aria-label", "File machine");
        const fresh = node("option", "New file machine"); fresh.value = ""; select.append(fresh);
        for (const machine of state.machines) { const option = node("option", machine.name); option.value = machine.id; select.append(option); }
        const { input } = field(question.title, answers.machine); input.setAttribute("aria-label", "New machine name"); input.oninput = () => save(input.value);
        select.value = answers.machineId ?? ""; input.hidden = !!select.value;
        select.onchange = () => {
          const machine = state.machines.find((item: any) => item.id === select.value);
          answers.machineId = machine?.id; input.hidden = !!machine;
          if (machine) { answers.qualifyPaths = machine.qualifyPaths; save(machine.name); } else save(input.value);
        };
        content.append(select, input);
      } else if (question.options) {
        const select = node("select"); select.setAttribute("aria-label", question.title);
        for (const [value, label] of question.options) { const option = node("option", String(label)); option.value = String(value); select.append(option); }
        select.value = String(answers[question.key]); select.onchange = () => save(["internet", "qualifyPaths"].includes(question.key) ? select.value === "true" : select.value); content.append(select);
      } else {
        const { input } = field(question.title, answers[question.key]); input.setAttribute("aria-label", question.title); input.maxLength = 100; input.oninput = () => save(input.value); content.append(input);
      }
      const help = node("details"); help.append(node("summary", "More"), node("p", question.key === "qualifyPaths" ? "Without the machine name, agents may need you to specify which machine the file is on." : question.key === "hub" ? "The hub must be available; moving it transfers the library while Markdown stays on its file machines." : question.key === "internet" ? "Your agent will configure HTTPS after your approval; enabling Tether Fly alone does not expose the hub." : "Setup uses an agent for installation and this page for your approvals.")); content.append(help);
      content.append(button("Back", () => { if (step) { step--; render(); } else void refresh(); }), button(step === list.length - 1 ? "Prepare setup" : "Next", () => void run(async () => {
        if (typeof answers[question.key] === "string" && !answers[question.key].trim()) throw new Error("Enter a computer name.");
        if (step < list.length - 1) { step++; render(); return; }
        await request("attempt", { answers, ...(previous ? { id: previous.id } : {}) }); await refresh();
      })));
    };
    render();
  };
  const render = () => {
    content.replaceChildren();
    if (!state.configured && !state.attempts?.length) { content.append(button("Enable Tether Fly", () => wizard())); return; }
    content.append(node("h3", "Tether Fly"), node("p", state.enabled ? `Hub: ${state.origin}` : "Tether Fly is not accepting connections."));
    if (state.origin) { const link = node("a", "Open hub"); link.href = state.origin + "/folio/"; link.target = "_blank"; link.rel = "noopener"; content.append(link); }
    content.append(button("Connect a machine or browser", () => wizard()), button("Internet access", () => wizard()));
    if (state.configured && localOwner) {
      content.append(button("Set up or recover owner passkey", () => void run(async () => {
        const child = window.open("about:blank", "tether-owner-enrollment");
        if (!child) throw new Error("Allow this Settings page to open the enrollment page, then retry.");
        let result: any;
        try { result = await request("recover"); } catch (cause) { child.close(); throw cause; }
        const origin = new URL(result.verificationUrl).origin;
        const receive = (event: MessageEvent) => {
          if (event.origin === origin && event.source === child && event.data?.type === "tether-enrollment-ready") { child.postMessage({ type: "tether-enrollment", code: result.code }, origin); window.removeEventListener("message", receive); }
        };
        window.addEventListener("message", receive); setTimeout(() => window.removeEventListener("message", receive), 300_000);
        child.location.href = result.verificationUrl;
        error.textContent = "Finish passkey enrollment in the HTTPS page, then return here.";
      })));
    }
    if (state.configured) {
      const password = field(state.passwordConfigured ? "Change fallback password" : "Create fallback password", "", "password"); password.input.autocomplete = "new-password"; password.input.maxLength = 128;
      content.append(password.element, button("Save password", () => void run(async () => { await request("password", { password: password.input.value }); password.input.value = ""; await refresh(); })));
      for (const machine of state.machines) {
        const group = node("section"); group.append(node("h4", `${machine.name} · ${machine.connected ? "available" : "offline"}`));
        const name = field("Machine name", machine.name), qualify = field("Include machine name in copied paths", "", "checkbox"); qualify.input.checked = machine.qualifyPaths;
        const sample = state.verificationDocuments?.find((document: any) => document.machineId === machine.id)?.path;
        const path = sample ?? "/path/document.md";
        const preview = node("p"), show = () => { preview.textContent = `${sample ? "" : "Example: "}${qualify.input.checked ? `${name.input.value}:` : ""}${path}`; }; name.input.oninput = show; qualify.input.onchange = show; show();
        group.append(name.element, qualify.element, preview, button("Save machine", () => void run(() => action("machine", { id: machine.id, name: name.input.value, qualifyPaths: qualify.input.checked }))));
        const clients = state.clients.filter((client: any) => client.machineId === machine.id && client.revokedAt === null);
        if (clients.length) group.append(button(`Revoke ${machine.name}`, () => { if (confirm(`Revoke ${machine.name}?\n${clients.map((client: any) => `${client.name} (${client.kind})`).join("\n")}`)) void run(() => action("revoke-machine", { machineId: machine.id, clientIds: clients.map((client: any) => client.id), confirmed: true })); }));
        content.append(group);
      }
      content.append(node("h4", "Browser sessions and unassociated clients"));
      for (const client of state.clients.filter((client: any) => !client.machineId && client.revokedAt === null)) {
        const row = node("p", `${client.name} (${client.kind}) · expires ${new Date(client.expiresAt).toLocaleDateString()} `);
        if (client.kind === "agent") {
          const select = node("select"); select.setAttribute("aria-label", `File machine for ${client.name}`);
          select.append(node("option", "Choose a file machine")); select.firstElementChild!.setAttribute("value", "");
          for (const machine of state.machines) { const option = node("option", machine.name); option.value = machine.id; select.append(option); }
          row.append(select, button("Associate", () => void run(async () => {
            if (!select.value) throw new Error("Choose this client’s file machine.");
            await action("associate", { clientId: client.id, machineId: select.value });
          })));
        }
        row.append(button("Revoke", () => { if (confirm(`Revoke ${client.name}?`)) void run(() => action("revoke", { clientId: client.id, confirmed: true })); })); content.append(row);
      }
      if (state.enabled) content.append(button("Disable Tether Fly…", () => {
        const dialog = node("dialog"); dialog.append(node("p", "Disable this hub?"), button("Disable all Tether Fly connections", () => { dialog.close(); dialog.remove(); void run(() => action("enabled", { enabled: false, confirmed: true })); }), button("Disable this machine and relocate Tether to a different one", () => { dialog.close(); dialog.remove(); wizard(undefined, true); }), button("Cancel", () => { dialog.close(); dialog.remove(); })); document.body.append(dialog); dialog.showModal();
      }));
      else if (localOwner) content.append(button("Enable Tether Fly again", () => void run(() => action("enabled", { enabled: true, confirmed: true }))));
      if (!localOwner) content.append(button("Sign out", () => void run(async () => { await fetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); location.assign("/auth/login?next=/settings/"); })));
    }
    for (const attempt of state.attempts ?? []) if (attempt.phase !== "cancelled") showAttempt(attempt);
  };
  async function refresh() {
    clearTimeout(timer); state = await request("status"); if (disposed) return;
    render(); timer = setTimeout(() => void poll(), 3000);
  }
  async function poll() {
    try { const next = await request("status"); if (JSON.stringify(next) !== JSON.stringify(state) && !root.contains(document.activeElement)) { state = next; render(); } }
    catch { error.textContent = "Waiting for the hub; this page will reconnect."; }
    if (!disposed) timer = setTimeout(() => void poll(), document.hidden ? 10_000 : 3000);
  }
  window.addEventListener("pagehide", () => { disposed = true; clearTimeout(timer); });
  void run(refresh);
}
