import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { Agentation, type AgentationProps } from "agentation";

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
const feedbackProps: AgentationProps = {
  appName: "Tether Settings staging", useHashLocation: true,
  onSubmit: async (output, annotations) => {
    const response = await fetch("/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: location.href, output, annotations }) });
    if (!response.ok) throw new Error("Could not save feedback. Please retry Send.");
    document.querySelector("#stage-feedback")!.textContent = "Feedback saved locally for your agent.";
  },
};
createRoot(root).render(createElement<AgentationProps>(Agentation, feedbackProps));
