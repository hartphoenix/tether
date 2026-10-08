/** Self-contained so local and shared Settings use exactly the same application. */
export function mountFlySettings(root: HTMLElement, request: (action: string, body?: unknown) => Promise<any>, localOwner: boolean, stepUrls = false) {
  let state: any, timer: ReturnType<typeof setTimeout>, disposed = false, editing = false, inWizard = false;
  let restoreStep: (() => void) | undefined;
  const navigate = (hash: string) => {
    if (!stepUrls || location.hash === hash) return;
    history.pushState(null, "", location.pathname + location.search + hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  };
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "") => { const element = document.createElement(tag); element.textContent = text; return element; };
  const error = node("p"); error.id = "fly-feedback"; error.setAttribute("role", "status");
  const content = node("section"); root.append(content, error);
  const protectDraft = (event: Event) => { const form = (event.target as HTMLElement).closest("form"); if (form) { form.dataset.dirty = "true"; editing = true; } };
  content.addEventListener("input", protectDraft);
  content.addEventListener("change", protectDraft);
  document.addEventListener("click", event => { for (const picker of root.querySelectorAll<HTMLDetailsElement>(".hub-picker[open]")) if (!picker.contains(event.target as Node)) picker.open = false; });
  const run = async (action: () => Promise<void>) => { error.textContent = ""; try { await action(); } catch (cause) { error.textContent = (cause as Error).message; } };
  const button = (label: string, action: () => void) => { const element = node("button", label); element.type = "button"; element.onclick = action; return element; };
  const field = (label: string, value: string, type = "text") => {
    const element = node("label", label), input = node("input"); input.type = type; input.value = value; element.append(input); return { element, input };
  };
  const action = async (name: string, body: unknown = {}, message = "Changes saved.") => { await request(name, body); await refresh(); error.textContent = message; };
  const actions = (...items: HTMLElement[]) => { const group = node("div"); group.className = "settings-actions"; group.append(...items); return group; };
  const disclosure = (title: string, parent: HTMLElement) => { const group = node("details"); group.append(node("summary", title)); parent.append(group); return group; };
  const hint = (text: string) => { const p = node("p", text); p.className = "settings-hint"; return p; };
  const prompt = (attempt: any) => {
    const destination = !state.configured || attempt.answers.access === "browser" ? "the hub" : attempt.answers.machine;
    const revision = state.sourceRevision ?? "the tested source revision supplied with this build";
    return `${attempt.answers.relocate ? `Relocate the existing Tether hub to ${attempt.answers.hub} using the prepare, release and activate procedure (pass --attempt ${attempt.id} to prepare); preserve the former hub as a file machine. Begin with an agent on the current hub and coordinate the destination before cutover.` : `Set up Tether Fly on ${destination}.`} Use https://github.com/hartphoenix/tether at ${revision}. Read docs/guide/shared-profile.md and docs/guide/fly-setup.md at that revision. Preserve the existing library and Markdown; do not create another authority. Hub: ${attempt.answers.hub}. HTTPS origin: ${state.origin ?? "establish a stable HTTPS origin on the hub first"}. Access: ${attempt.answers.access}. ${attempt.answers.access === "wave" ? "Wave currently delivers shared document links for the owner to open; do not claim automatic background placement." : attempt.answers.access === "cmux" ? "Set up the cmux receiver in the intended workspace and verify actual background reader delivery." : ""}${attempt.answers.machineId === state.localMachineId ? " This is the hub’s own file machine: preserve its ID and configure it directly; do not pair a connector to itself." : ""} File machine: ${attempt.answers.machine || "browser only"}. Retained machine ID: ${attempt.answers.machineId ?? "select a new identity only for a new file machine"}. Qualify copied paths: ${attempt.answers.qualifyPaths ? "yes" : "no"}. Internet access explicitly requested: ${attempt.answers.internet ? "yes" : "no"}. Setup attempt: ${attempt.id}. Request owner approval for the scoped reporting capability; report progress automatically and poll approvals. Verify service observations before declaring completion. Use the source installer and preserve existing machine IDs when re-pairing. Additional requirements are welcome; report unsupported configurations before changing the plan.`;
  };
  const showAttempt = (attempt: any) => {
    const section = attempt.phase === "verified" ? disclosure("Completed setup", content) : node("section");
    section.className = "settings-section";
    section.append(node("h4", attempt.phase === "verified" ? "Setup verified" : "Continue setup"));
    if (attempt.verification && attempt.phase === "verified") {
      section.append(node("p", "Verified: browser sign-in and file access, with the selected live checks confirmed by you."));
      content.append(section); return;
    }
    section.append(node("p", !state.configured || attempt.answers.relocate ? "Paste this into an agent session on the current hub." : `Paste this into an agent session ${attempt.answers.access === "browser" ? "on the hub" : `on ${attempt.answers.machine}`}.`));
    const text = node("textarea"); text.readOnly = true; text.value = prompt(attempt); text.rows = 5; text.setAttribute("aria-label", "Setup prompt");
    section.append(text, button("Copy prompt", () => void run(async () => { await navigator.clipboard.writeText(text.value); error.textContent = "Prompt copied."; })));
    const help = node("details"); help.append(node("summary", "No agent session yet?"), node("p", "Open your coding agent on the chosen computer, then paste the prompt. You can use an existing session in Paseo, cmux or Wave.")); section.append(help);
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
      const native = field(attempt.answers.access === "paseo" ? "I verified the native sidebar, sign-in, notice, edit/review workflow, theme and tab restoration." : `I opened a document in ${attempt.answers.access === "wave" ? "Wave" : "cmux"} and checked sign-in, editing, comments and appearance.`, "", "checkbox");
      const internet = field("I verified access from a browser outside the private network.", "", "checkbox");
      if (attempt.answers.access !== "browser") section.append(machines);
      section.append(documents);
      if (attempt.answers.access === "paseo") section.append(clients);
      if (attempt.answers.access !== "browser") section.append(native.element);
      if (attempt.answers.internet) section.append(internet.element);
      section.append(button("Verify setup", () => void run(() => action("verify-attempt", { id: attempt.id, machineId: machines.value, documentId: documents.value, clientId: clients.value, nativeConfirmed: native.input.checked, internetConfirmed: internet.input.checked }))));
    } else if (state.origin) {
      const link = node("a", "Finish verification in hub Settings"); link.href = state.origin + "/settings/"; link.target = "tether-settings-verify"; section.append(link);
    }
    content.append(section);
  };
  const wizard = (previous?: any, relocate = false) => {
    relocate ||= previous?.answers.relocate === true;
    clearTimeout(timer); inWizard = true; root.closest("#settings-dialog")?.classList.add("fly-setup-page");
    const routeId = previous?.id ?? (relocate ? "relocate" : "setup");
    const draftKey = stepUrls ? "tether.fly.draft:" + location.pathname.split("/")[1] + ":" + routeId : "tether.fly.draft";
    const hubId = state.hubMachineId ?? state.localMachineId;
    const hub = state.machines?.find((machine: any) => machine.id === hubId);
    const initial = !state.configured || previous?.answers.initialSetup === true;
    const local = state.machines?.find((machine: any) => machine.id === (state.viewerMachineId ?? state.localMachineId));
    let answers = previous ? { ...previous.answers } : { hub: hub?.name ?? local?.name ?? "This computer", machine: initial ? local?.name ?? "This computer" : "", machineId: initial ? local?.id : undefined, access: "paseo", qualifyPaths: initial ? local?.qualifyPaths ?? false : false, internet: false, initialSetup: initial };
    if (relocate && !previous) answers = { ...answers, relocate: true, hub: hub?.name, machine: hub?.name, machineId: hubId, access: "browser", initialSetup: false };
    if (stepUrls && (!relocate || location.hash.split("/")[1] === routeId) || !previous && !relocate) try { const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null"); if (saved) answers = { ...answers, ...saved }; } catch {}
    if (initial && !relocate) Object.assign(answers, { hub: hub?.name ?? local?.name, machine: local?.name, machineId: local?.id, initialSetup: true });
    let step = 0;
    type Question = { key: string; title: string; brief: string; detail: string; options?: (string | boolean)[][] };
    const questions = (): Question[] => relocate ? [{ key: "hub", title: "Which computer should be Tether’s hub?",
      brief: "Your hub keeps your shared library available to your other computers. Choose a computer you usually leave on.",
      detail: "Your documents stay on the computers where they are saved. If you choose a different hub, your setup agent will move the library and its comments there, then reconnect your computers. Keep the current hub running until the agent tells you the move is complete." }] : [
      { key: "access", title: "Where will you primarily use Tether?", options: [["paseo", "Paseo"], ["cmux", "cmux"], ["wave", "Wave"], ["browser", "Browser"]],
        brief: initial ? "Start with this computer; you can connect your other computers next. This choice helps your setup agent prepare the app you use most." : "Choose the app you use most on the computer you’re connecting. You can also open your library in a browser.",
        detail: "Paseo and cmux can open Tether documents inside their own workspaces. Wave users can open the document links provided by Tether. Choosing Browser lets you read and review files from computers already connected to your library, without installing anything in that browser." },
      ...(answers.access === "browser" ? [] : [
        ...(!initial ? [{ key: "machine", title: "Which computer are you connecting next?", brief: "Connect one computer at a time, then repeat for the others. Choose a computer already listed to reconnect it, or give the new one a name.", detail: "Use a short name you will recognize, such as Work laptop. Run the setup agent on that computer so it can connect the files stored there. Your documents stay where they are; this step lets your other devices reach them through Tether." }] : []),
        { key: "qualifyPaths", title: 'Should "copy file path" shortcuts in Tether include this computer’s name when pointing to its files?', options: [[false, "No"], [true, "Yes"]],
          brief: "Including the computer’s name makes it clear where a file lives. Leave it off if you prefer to copy just the file’s location.",
          detail: "For example, a copied location can look like Work laptop:/notes/plan.md instead of /notes/plan.md. The name helps an agent tell which computer to use when several are connected. This changes copied text only; it does not rename or move your files." },
      ]),
      { key: "internet", title: "Allow browser access from outside your private network?", options: [[false, "No"], [true, "Yes"]],
        brief: "You will still need your passkey or password to sign in. Choose Yes to reach Tether from a browser that is not on your private network.",
        detail: "Your setup agent will arrange a secure web address and ask for any permissions it needs. Turning on Tether Fly alone does not expose your hub to the internet. If you choose No, browsers will need to join your private network before they can reach it." },
    ];
    const leave = () => { restoreStep = undefined; inWizard = false; navigate(""); editing = false; renderSettings(); void poll(); };
    const render = () => {
      const list = questions(); step = Math.min(step, list.length - 1); const question = list[step]!;
      navigate(`#fly/${routeId}/${question.key}`);
      const back = node("a", "← Settings"); back.href = location.pathname + location.search; back.className = "setup-back"; back.onclick = event => { event.preventDefault(); leave(); };
      content.replaceChildren(back, node("h3", relocate ? "Choose your hub" : previous ? "Change setup" : initial ? "Set up Tether Fly" : "Connect another computer or browser"), node("h4", question.title));
      const progress = hint(`Step ${step + 1} of ${list.length}`); progress.setAttribute("aria-label", `Question ${step + 1} of ${list.length}`); content.append(progress);
      const save = (value: unknown) => { answers[question.key] = value; try { localStorage.setItem(draftKey, JSON.stringify(answers)); } catch {} };
      if (question.key === "hub") {
        const picker = node("details"); picker.className = "hub-picker";
        const selected = node("summary"); selected.setAttribute("aria-label", question.title);
        picker.onkeydown = event => { if (event.key === "Escape") { event.preventDefault(); picker.open = false; selected.focus(); } };
        const choices = node("div"); choices.className = "hub-options"; choices.setAttribute("role", "radiogroup"); choices.setAttribute("aria-label", question.title);
        const label = (machine: any) => machine.name + (machine.id === state.viewerMachineId || localOwner && machine.id === state.localMachineId ? " (this machine)" : "") + (machine.connected === false ? " · Offline" : "");
        const showSelected = (machine: any) => selected.replaceChildren(node(machine.id === hubId ? "strong" : "span", label(machine)));
        const current = state.machines.find((machine: any) => machine.id === answers.machineId) ?? hub;
        showSelected(current);
        for (const machine of state.machines) {
          const option = node("label"), radio = node("input"); radio.type = "radio"; radio.name = "hub-machine"; radio.value = machine.id;
          radio.checked = machine.id === current.id; radio.disabled = machine.connected === false && machine.id !== hubId;
          radio.onchange = () => { answers.machineId = machine.id; answers.machine = machine.name; answers.qualifyPaths = machine.qualifyPaths; save(machine.name); showSelected(machine); picker.open = false; selected.focus(); };
          radio.onclick = () => { picker.open = false; selected.focus(); };
          option.append(radio, node(machine.id === hubId ? "strong" : "span", label(machine))); choices.append(option);
        }
        picker.append(selected, choices); content.append(picker);
      } else if (question.key === "machine" && state.machines?.length) {
        const select = node("select"); select.setAttribute("aria-label", "File machine");
        const fresh = node("option", "New computer"); fresh.value = ""; select.append(fresh);
        for (const machine of state.machines) { const option = node("option", machine.name); option.value = machine.id; select.append(option); }
        const { input } = field(question.title, answers.machine); input.setAttribute("aria-label", "New machine name"); input.maxLength = 100; input.oninput = () => save(input.value);
        select.value = answers.machineId ?? ""; input.hidden = !!select.value;
        select.onchange = () => { const machine = state.machines.find((item: any) => item.id === select.value); answers.machineId = machine?.id; input.hidden = !!machine; if (machine) { answers.qualifyPaths = machine.qualifyPaths; save(machine.name); } else save(input.value); };
        content.append(select, input);
      } else if (question.options) {
        const select = node("select"); select.setAttribute("aria-label", question.title);
        for (const [value, label] of question.options) { const option = node("option", String(label)); option.value = String(value); select.append(option); }
        select.value = String(answers[question.key]); select.onchange = () => save(["internet", "qualifyPaths"].includes(question.key) ? select.value === "true" : select.value); content.append(select);
      }
      const help = node("details"); help.className = "setup-help"; help.append(node("summary", "About this choice"), node("p", question.detail)); content.append(hint(question.brief), help);
      content.append(actions(button(step ? "Back" : "Cancel", () => { if (step) { step--; render(); } else leave(); }), button(step === list.length - 1 ? relocate ? "Continue" : "Prepare setup" : "Next", () => void run(async () => {
        if (typeof answers[question.key] === "string" && !answers[question.key].trim()) throw new Error("Enter a computer name.");
        if (step < list.length - 1) { step++; render(); return; }
        if (relocate && answers.machineId === hubId) { try { localStorage.removeItem(draftKey); } catch {} leave(); return; }
        if (answers.access === "browser" && !relocate) { answers.machine = ""; delete answers.machineId; }
        await request("attempt", { answers, ...(previous ? { id: previous.id } : {}) }); try { localStorage.removeItem(draftKey); } catch {} restoreStep = undefined; inWizard = false; navigate(""); await refresh();
      }))));
      const heading = content.querySelector("h4")!; heading.tabIndex = -1; heading.focus();
    };
    restoreStep = () => { if (location.hash.split("/")[1] !== routeId) { resumeWizard(); return; } const index = questions().findIndex(question => question.key === location.hash.split("/")[2]); if (index >= 0 && index !== step) { step = index; render(); } };
    if (stepUrls && location.hash.split("/")[1] === routeId) { const index = questions().findIndex(question => question.key === location.hash.split("/")[2]); if (index >= 0) step = index; }
    render();
  };
  const resumeWizard = () => { const target = location.hash.split("/")[1]; wizard(state.attempts?.find((attempt: any) => attempt.id === target), target === "relocate"); };
  const renderSettings = () => {
    root.closest("#settings-dialog")?.classList.remove("fly-setup-page");
    const expanded = new Set([...content.querySelectorAll("details[open]")].map(group => group.querySelector("summary")?.textContent));
    content.replaceChildren();
    content.append(node("h3", "Tether Fly"), hint("Use one library across your computers and browsers."));
    if (!state.configured && !state.attempts?.length) { content.append(button("Set up Tether Fly", () => wizard())); return; }
    const connection = node("p", state.enabled ? "Connections enabled" : "Connections disabled");
    if (state.origin) { const link = node("a", "Open hub"); link.href = state.origin + "/folio/"; link.target = "_blank"; link.rel = "noopener"; connection.append(" · ", link); }
    content.append(connection, actions(button("Connect a machine or browser", () => wizard())));
    if (state.configured && !(state.attempts ?? []).some((attempt: any) => !["verified", "cancelled"].includes(attempt.phase))) content.append(button("All my computers are connected", () => wizard(undefined, true)));
    for (const attempt of state.attempts ?? []) if (attempt.phase !== "cancelled") showAttempt(attempt);
    const security = state.configured ? disclosure("Sign-in and security", content) : content;
    if (state.configured && localOwner) {
      security.append(hint("Passkeys sign you in securely on the hub. Recovery replaces your owner sign-in credential."), button("Set up or recover owner passkey", () => void run(async () => {
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
      const passwordForm = node("form");
      password.input.required = true; password.input.minLength = 15;
      const passwordHelp = hint("Use a unique password or passphrase of 15–128 characters if you cannot use a passkey."); passwordHelp.id = "password-help"; password.input.setAttribute("aria-describedby", passwordHelp.id);
      const savePassword = button("Save password", () => {}); savePassword.type = "submit";
      passwordForm.onsubmit = event => { event.preventDefault(); void run(async () => { savePassword.disabled = true; try { await action("password", { password: password.input.value }, "Password saved."); } finally { savePassword.disabled = false; } }); };
      passwordForm.append(password.element, passwordHelp, actions(savePassword)); security.append(passwordForm);
      const machines = disclosure(`File machines (${state.machines.length})`, content);
      machines.append(hint("Names identify your computers. Path preferences apply when copying a file path."));
      const table = node("table"); table.className = "machine-table"; table.setAttribute("aria-label", "File machines");
      const head = node("thead"), headings = node("tr"), rows = node("tbody");
      for (const label of ["Machine", "Availability", "Copied paths", "Actions"]) { const cell = node("th", label); cell.scope = "col"; headings.append(cell); }
      head.append(headings); table.append(head, rows); machines.append(table);
      const focusEdit = (id: string) => [...content.querySelectorAll<HTMLButtonElement>("[data-edit-machine]")].find(button => button.dataset.editMachine === id)?.focus();
      const editMachine = (machine: any) => {
        editing = true; error.textContent = ""; table.hidden = true;
        const group = node("form"); group.className = "settings-section"; group.setAttribute("aria-label", `Edit ${machine.name}`); group.append(node("h4", `${machine.name} · ${machine.connected ? "Available" : "Offline"}`));
        const name = field("Machine name", machine.name), qualify = field("Include machine name in copied paths", "", "checkbox"); qualify.input.checked = machine.qualifyPaths;
        const sample = state.verificationDocuments?.find((document: any) => document.machineId === machine.id)?.path;
        const path = sample ?? "/path/document.md";
        name.input.required = true; name.input.maxLength = 100;
        const preview = node("p"); preview.className = "machine-preview"; const show = () => { preview.textContent = `${sample ? "" : "Example: "}${qualify.input.checked ? `${name.input.value}:` : ""}${path}`; }; name.input.oninput = show; qualify.input.onchange = show; show();
        const saveMachine = button("Save machine", () => {}); saveMachine.type = "submit";
        const cancelMachine = button("Cancel", () => { group.remove(); table.hidden = false; editing = !!content.querySelector("form[data-dirty]"); error.textContent = ""; focusEdit(machine.id); });
        group.onsubmit = event => { event.preventDefault(); void run(async () => { saveMachine.disabled = cancelMachine.disabled = true; try { await action("machine", { id: machine.id, name: name.input.value, qualifyPaths: qualify.input.checked }, "Machine saved."); focusEdit(machine.id); } finally { saveMachine.disabled = cancelMachine.disabled = false; } }); };
        const machineActions = actions(saveMachine, cancelMachine);
        group.append(name.element, qualify.element, preview, machineActions);
        const clients = state.clients.filter((client: any) => client.machineId === machine.id && client.revokedAt === null);
        if (clients.length) { const revoke = button(`Revoke access`, () => { if (confirm(`Revoke ${machine.name}?\n${clients.map((client: any) => `${client.name} (${client.kind})`).join("\n")}`)) void run(() => action("revoke-machine", { machineId: machine.id, clientIds: clients.map((client: any) => client.id), confirmed: true }, "Machine access revoked.")); }); revoke.className = "danger"; machineActions.append(revoke); }
        machines.append(group); name.input.focus();
      };
      for (const machine of state.machines) {
        const row = node("tr"), name = node("th", machine.name), edit = node("td"); name.scope = "row";
        const editButton = button("Edit", () => editMachine(machine)); editButton.setAttribute("aria-label", `Edit ${machine.name}`); editButton.dataset.editMachine = machine.id; edit.append(editButton);
        row.append(name, node("td", machine.connected ? "Available" : "Offline"), node("td", machine.qualifyPaths ? "Machine + path" : "Path only"), edit); rows.append(row);
      }
      const unassociated = state.clients.filter((client: any) => !client.machineId && client.revokedAt === null);
      const sessions = disclosure(`Browsers and other clients (${unassociated.length})`, content);
      if (!unassociated.length) sessions.append(hint("No active browser sessions or unassociated clients."));
      for (const client of unassociated) {
        const row = node("div"); row.className = "client-row"; row.append(node("span", `${client.name} (${client.kind}) · expires ${new Date(client.expiresAt).toLocaleDateString()}`));
        if (client.kind === "agent") {
          const select = node("select"); select.setAttribute("aria-label", `File machine for ${client.name}`);
          select.append(node("option", "Choose a file machine")); select.firstElementChild!.setAttribute("value", "");
          for (const machine of state.machines) { const option = node("option", machine.name); option.value = machine.id; select.append(option); }
          row.append(select, button("Associate", () => void run(async () => {
            if (!select.value) throw new Error("Choose this client’s file machine.");
            await action("associate", { clientId: client.id, machineId: select.value });
          })));
        }
        const revoke = button("Revoke access", () => { if (confirm(`Revoke ${client.name}?`)) void run(() => action("revoke", { clientId: client.id, confirmed: true }, "Access revoked.")); }); revoke.className = "danger"; row.append(revoke); sessions.append(row);
      }
      const advanced = disclosure("Hub controls", content);
      advanced.append(hint("Configure internet access, disconnect clients, or move the hub to another computer."), button("Internet access", () => wizard()), button("Choose hub", () => wizard(undefined, true)));
      if (state.enabled) advanced.append(button("Disable Tether Fly…", () => {
        const dialog = node("dialog"); dialog.className = "settings-confirm"; dialog.setAttribute("aria-label", "Disable Tether Fly"); dialog.append(node("p", "Disable this hub?"), button("Disable all Tether Fly connections", () => { dialog.close(); dialog.remove(); void run(() => action("enabled", { enabled: false, confirmed: true })); }), button("Disable this machine and relocate Tether to a different one", () => { dialog.close(); dialog.remove(); wizard(undefined, true); }), button("Cancel", () => { dialog.close(); dialog.remove(); })); document.body.append(dialog); dialog.showModal();
      }));
      else if (localOwner) advanced.append(button("Enable Tether Fly again", () => void run(() => action("enabled", { enabled: true, confirmed: true }))));
      if (!localOwner) content.append(button("Sign out", () => void run(async () => { await fetch("/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); location.assign("/auth/login?next=/settings/"); })));
    }
    for (const group of content.querySelectorAll("details")) if (expanded.has(group.querySelector("summary")?.textContent)) group.open = true;
  };
  async function refresh() {
    clearTimeout(timer); state = await request("status"); if (disposed) return;
    editing = false; inWizard = false; renderSettings();
    if (stepUrls && location.hash.startsWith("#fly/")) resumeWizard();
    else timer = setTimeout(() => void poll(), 3000);
  }
  async function poll() {
    try { const next = await request("status"); if (!disposed && !inWizard && !editing && JSON.stringify(next) !== JSON.stringify(state) && !root.contains(document.activeElement)) { state = next; renderSettings(); } }
    catch { error.textContent = "Waiting for the hub; this page will reconnect."; }
    if (!disposed && !inWizard) timer = setTimeout(() => void poll(), document.hidden ? 10_000 : 3000);
  }
  window.addEventListener("pagehide", () => { disposed = true; clearTimeout(timer); });
  if (stepUrls) window.addEventListener("hashchange", () => {
    if (!state) return;
    if (location.hash.startsWith("#fly/")) { if (restoreStep) restoreStep(); else resumeWizard(); }
    else if (inWizard) { restoreStep = undefined; inWizard = false; editing = false; renderSettings(); void poll(); }
  });
  void run(refresh);
}
