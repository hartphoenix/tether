import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

const status = document.querySelector<HTMLElement>("#status")!;
async function post(path: string, value: unknown) {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  if (!response.ok) throw new Error("Request denied or expired. Start again from the reader.");
  return response.json();
}
function action(id: string, run: () => Promise<void>) {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  button?.addEventListener("click", async () => {
    button.disabled = true;
    try { status.textContent = "Waiting for your passkey…"; await run(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : "Could not verify your passkey."; }
    finally { button.disabled = false; }
  });
}
action("register", async () => {
  const input = document.querySelector<HTMLInputElement>("#setup-code")!;
  const options = await post("/registration/options", { code: input.value });
  input.value = "";
  const response = await startRegistration({ optionsJSON: options.options });
  await post("/registration/verify", { challengeId: options.id, response });
  status.textContent = "Passkey enrolled. Return to the private reader address on your phone.";
});
action("authenticate", async () => {
  const requestId = document.getElementById("authenticate")!.dataset.request;
  const options = await post("/authentication/options", { requestId });
  const response = await startAuthentication({ optionsJSON: options.options });
  const result = await post("/authentication/verify", { challengeId: options.id, response });
  if (result.revoked) { status.textContent = "All phone sessions and pending requests ended."; return; }
  // Handoff is a one-use POST body, never a URL or localStorage credential.
  const form = document.createElement("form"); form.method = "POST"; form.action = result.action;
  const input = document.createElement("input"); input.type = "hidden"; input.name = "code"; input.value = result.code;
  form.append(input); document.body.append(form); form.submit();
});
