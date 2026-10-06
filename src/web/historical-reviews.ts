type Thread = { id: string; actor: string; excerpt: string; status: string };
type Message = { actor: string; body: string; createdAt: string };
type Fragment = { seq: number; fragment: { offset: number; nextOffset: number | null; text: string } };
type Page = { threads?: Thread[]; messages?: Array<Message | Fragment>; continuation: string | null };

/** Body-free review pages stay usable while the file machine is unavailable. */
export async function showHistoricalReviews(read: (query: string) => Promise<Page>, parent: HTMLElement): Promise<void> {
  if (document.getElementById("historical-reviews")) return;
  const page = await read("");
  const panel = document.createElement("section"); panel.id = "historical-reviews";
  panel.style.cssText = "max-width:54rem;margin:2rem auto;padding:1rem;white-space:pre-wrap";
  const heading = document.createElement("h2"); heading.textContent = "Historical comments";
  const context = document.createElement("p"); context.textContent = "The current file and passage context are unavailable. These comments are from the shared review store.";
  const folio = document.createElement("a"); folio.href = "/folio/"; folio.textContent = "Open Folio";
  panel.append(heading, context, folio); parent.append(panel);
  const moreButton = (container: HTMLElement, label: string, load: () => Promise<void>) => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.onclick = async () => { button.disabled = true; try { await load(); button.remove(); } catch { button.disabled = false; button.textContent = "Could not load. Retry"; } };
    container.append(button);
  };
  const appendThreads = (value: Page) => {
    for (const thread of value.threads ?? []) {
      const detail = document.createElement("details"), title = document.createElement("summary"), messages = document.createElement("div");
      title.textContent = `${thread.actor} · ${thread.status}: ${thread.excerpt}`;
      detail.append(title, messages); panel.append(detail);
      let opened = false, partial = "";
      const appendMessages = (result: Page) => {
        for (const item of result.messages ?? []) {
          let message: Message;
          if ("fragment" in item) {
            if (item.fragment.offset === 0) partial = "";
            partial += item.fragment.text;
            if (item.fragment.nextOffset !== null) continue;
            message = JSON.parse(partial); partial = "";
          } else message = item;
          const paragraph = document.createElement("p"); paragraph.textContent = `${message.actor} · ${message.createdAt}\n${message.body}`; messages.append(paragraph);
        }
        if (result.continuation) moreButton(messages, "More messages", async () => appendMessages(await read(`threadId=${encodeURIComponent(thread.id)}&continuation=${encodeURIComponent(result.continuation!)}`)));
      };
      detail.ontoggle = async () => {
        if (!detail.open || opened) return;
        opened = true;
        try { appendMessages(await read(`threadId=${encodeURIComponent(thread.id)}`)); }
        catch { opened = false; messages.textContent = "Could not load this conversation. Close and reopen to retry."; }
      };
    }
    if (value.continuation) moreButton(panel, "More conversations", async () => appendThreads(await read(`continuation=${encodeURIComponent(value.continuation!)}`)));
  };
  appendThreads(page);
}
