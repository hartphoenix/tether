import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Agentation, getStorageKey, loadAnnotations, type Annotation, type AgentationProps } from "agentation";

const mode = location.pathname.split("/")[1]!;
const request = async (action: string) => {
  const response = await fetch(`/${mode}/api/stage/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!response.ok) document.querySelector("#stage-feedback")!.textContent = (await response.json()).error.message;
};
document.querySelectorAll<HTMLButtonElement>("[data-stage-action]").forEach(button => {
  button.onclick = () => {
    if (button.dataset.stageAction === "reset") {
      if (!confirm("Reset this simulation? Your Agentation feedback will be kept.")) return;
      for (const key of Object.keys(localStorage)) if (key.startsWith("tether.fly.draft:" + mode + ":")) localStorage.removeItem(key);
    }
    void request(button.dataset.stageAction!);
  };
});
const root = document.createElement("div"); document.body.append(root);
async function sendFeedback(current?: { url: string; output: string; annotations: Annotation[] }) {
  const prefix = getStorageKey("");
  const pages = new Map<string, { url: string; output?: string; annotations: Annotation[] }>();
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length);
    if (!/^\/(fresh|existing)\//.test(path)) continue;
    const annotations = loadAnnotations(path);
    if (annotations.length) pages.set(path, { url: new URL(path, location.origin).href, annotations });
  }
  if (current) { const url = new URL(current.url); pages.set(url.pathname + url.hash, current); }
  if (!pages.size) return;
  const response = await fetch("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pages: [...pages.values()] }) });
  if (!response.ok) throw new Error("Could not save feedback. Please retry Send all feedback.");
  const count = [...pages.values()].reduce((sum, page) => sum + page.annotations.length, 0);
  document.querySelector("#stage-feedback")!.textContent = `Saved ${count} notes across ${pages.size} pages for your agent.`;
}
const sendAll = () => void sendFeedback().catch(error => { document.querySelector("#stage-feedback")!.textContent = error.message; });
document.querySelector<HTMLButtonElement>("#stage-send-feedback")!.onclick = sendAll;
// Recover feedback accumulated on other routes before this integration was added.
sendAll();
const feedbackProps: AgentationProps = {
  appName: "Tether Settings staging", useHashLocation: true,
  onSubmit: async (output, annotations) => {
    await sendFeedback({ url: location.href, output, annotations });
  },
};
createRoot(root).render(createElement<AgentationProps>(Agentation, feedbackProps));
