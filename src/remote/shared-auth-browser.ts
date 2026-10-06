import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { SharedClient } from "./shared-auth";

const status = document.querySelector<HTMLElement>("#status")!;
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message ?? "Request failed or expired.");
  return value;
}
async function verify(action: string, values: Record<string, unknown> = {}) {
  const options = await post("/auth/options", { action, ...values });
  const response = action === "register" ? await startRegistration({ optionsJSON: options.options }) : await startAuthentication({ optionsJSON: options.options });
  return post("/auth/verify", { challengeId: options.id, response });
}
function clients(values: SharedClient[]) {
  const container = document.getElementById("clients")!; container.replaceChildren();
  for (const client of values) {
    const row = document.createElement("p"), name = document.createElement("span");
    name.textContent = `${client.name} (${client.kind}) · ${client.revokedAt !== null ? "revoked" : client.expiresAt <= Date.now() ? "expired" : "authorized"} `;
    row.append(name);
    if (client.revokedAt === null && client.expiresAt > Date.now()) {
      const button = document.createElement("button"); button.textContent = "Revoke";
      button.addEventListener("click", () => run(button, async () => { const value = await verify("revoke", { clientId: client.id }); clients(value.clients); status.textContent = "Revocation applied at the profile service."; }));
      row.append(button);
    }
    container.append(row);
  }
}
async function run(button: HTMLButtonElement, action: () => Promise<void>) {
  button.disabled = true; status.textContent = "Waiting for owner verification…";
  try { await action(); } catch (error) { status.textContent = error instanceof Error ? error.message : "Verification failed."; }
  finally { button.disabled = false; }
}
function action(id: string, callback: () => Promise<void>) {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  button?.addEventListener("click", () => run(button, callback));
}
const value = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
action("login", async () => { await verify("login", { name: value("name") }); location.assign(document.getElementById("login")!.dataset.next ?? "/folio"); });
action("register", async () => { const result = await verify("register", { code: value("code") }); (document.getElementById("code") as HTMLInputElement).value = ""; clients(result.clients); status.textContent = "Owner passkey enrolled. Existing clients are preserved; revoke any you no longer recognize."; });
action("list", async () => { clients((await verify("list")).clients); status.textContent = "Authorized clients loaded."; });
const context = document.getElementById("context");
if (context) {
  const requestId = context.dataset.request;
  post("/auth/pair/context", { requestId }).then(request => { context.textContent = `${request.name} requests ${request.kind} access to this shared library. Check its name and code before approving.${request.machineId ? ` File machine: ${request.machineId}.` : ""}${request.replaces?.length ? ` Approval will replace the connector credential for ${request.replaces.join(", ")}.` : ""}`; }).catch(error => { context.textContent = error.message; });
  action("approve", async () => { await verify("approve", { requestId, code: value("code") }); status.textContent = "Client approved. Return to the requesting machine."; });
}
