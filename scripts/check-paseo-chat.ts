import { themePresets } from "../src/shared/theme-presets";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { PrivateStore } from "../src/storage/private-store";
import { ChatStore } from "../src/chat/store";
import { formatDrafts, parseChatRequest } from "../integrations/paseo/chat/model";
const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const build = await Bun.build({ entrypoints: ["integrations/paseo/chat/client.ts"], target: "browser" });
if (!build.success) throw new Error(build.logs.join("\n"));
const source = await build.outputs[0].text(), owner = new PrivateStore(), store = new ChatStore(owner.db);
const browser = await chromium.launch({ headless: true });
const saved = (agent = a) => store.read(JSON.stringify(["host", agent]));
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await page.route("http://localhost/chat", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("http://localhost/chat");
  let failSave = false;
  await page.exposeFunction("chatRpc", async (raw: unknown) => {
    const request = parseChatRequest(raw);
    if (request.operation.kind === "save") { await new Promise(r => setTimeout(r, 80)); if (failSave) throw Error("fixture disk failure"); }
    return store.operate(request);
  });
  await page.exposeFunction("receiptRpc", async ({ host, agent }: { host: string; agent: string }) => {
    const state = store.read(JSON.stringify([host, agent])), pending = state.submission;
    const accepted = pending?.messageId && await page.evaluate(id => (window as any).receipts.has(id), pending.messageId);
    return { accepted: !!accepted, state: accepted ? store.operate({ host, agent, operation: { kind: "accepted", id: pending!.id, messageId: pending!.messageId } }) : state };
  });
  await page.setContent(`<style>:root { --colors-foreground:#eee; --colors-foreground-muted:#ccc; --colors-surface0:#171717; --colors-surface1:#242424; --colors-surface2:#333; --colors-border:#666; --colors-border-accent:#aaa; --colors-accent:#e7a641; --colors-accent-foreground:#111; } body {background:#171717;color:#eee;display:flex;gap:30px;padding:30px;font:16px system-ui} section.pane {width:450px} .scroll {height:250px;overflow:auto;border:1px solid #777} .content {min-height:650px;padding:20px} p {margin-top:20px} textarea[data-composer-input] {height:70px;width:340px} .tool {width:250px;overflow:auto} pre {width:1400px}</style>
  ${["a", "b"].map(key => `<section class="pane" id="${key}"><div class="scroll" data-testid="agent-chat-scroll"><div class="content"><div data-message-id="row-${key}" data-testid="assistant-message"><p>First passage in chat ${key} with useful text.</p><p>Second passage in chat ${key}.</p><div class="tool"><pre data-pmono>Long tool line with a unique anchor and more content ${"abcdef ".repeat(50)}</pre></div></div></div></div><div data-testid="message-input-root"><textarea data-composer-input></textarea><button aria-label="Send">Send</button></div></section>`).join("")}<section id="new"><div data-testid="message-input-root"><textarea data-composer-input></textarea></div></section>`);
  await page.evaluate(async ({ source, a, b }) => {
    const w = window as any; w.paseoDesktop = {}; w.sent = []; w.queues = new Map(); w.props = {}; w.receipts = new Set(); w.lose = false; w.newSends = 0;
    w.native = { async sendAgentMessage(agent: string, text: string, options: any = { messageId: crypto.randomUUID() }) { w.sent.push({ agent, text, options }); w.receipts.add(options.messageId); if (w.lose) { w.lose = false; throw Error("fixture lost acceptance"); } }, async fetchAgentTimeline() { return { entries: [], hasOlder: false, startCursor: null }; }, async deleteAgent() {} };
    w.original = w.native.sendAgentMessage;
    for (const [key, agent] of [["a", a], ["b", b], ["new", "tab_draft"]]) {
      const input = document.querySelector<HTMLTextAreaElement>(`#${key} textarea`)!;
      const q = { read: (id: string) => w.queues.get(id) ?? [], write: (update: any) => { w.queues = update(w.queues); } };
      const p = { voiceServerId: "host", voiceAgentId: agent, client: w.native, attachments: [{ kind: "file", attachment: { type: "uploaded_file", id: "fixture-file", path: "/fixture" } }], onSubmit() {}, defaultSendBehavior: "steer", isAgentRunning: false };
      w.props[key] = p; w.props[key].q = q;
      Reflect.set(input, "__reactFiber$fixture", { memoizedProps: p, memoizedState: { memoizedState: [q, []] } });
      const send = async () => {
        if (key === "new") { w.newSends++; input.value = ""; return; }
        const text = input.value.trim(); if (!text) return; input.value = "";
        if (p.isAgentRunning && p.defaultSendBehavior === "queue") { q.write((before: Map<string, any[]>) => new Map(before).set(agent, [...(before.get(agent) ?? []), { id: crypto.randomUUID(), text, attachments: p.attachments }])); return; }
        try { await w.native.sendAgentMessage(agent, text, { messageId: crypto.randomUUID(), activeTurnBehavior: p.defaultSendBehavior, images: [{ data: "fixture-png", mimeType: "image/png" }], attachments: p.attachments.map((x: any) => x.attachment) }); }
        catch (error) { w.lastError = String(error); input.value = text; }
      };
      input.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.defaultPrevented) { e.preventDefault(); void send(); } });
      const button = document.querySelector<HTMLButtonElement>(`#${key} button`);
      if (button) { button.onclick = () => { void send(); }; Reflect.set(button, "__reactFiber$fixture", { memoizedProps: { onDefaultSendAction() {}, submitAccessibilityLabel: "Send", shouldShow: true } }); }
    }
    w.drain = async (agent: string) => {
      const item = w.queues.get(agent)?.[0]; if (!item) return;
      w.queues.set(agent, w.queues.get(agent).slice(1));
      try { await w.native.sendAgentMessage(agent, item.text, { messageId: crypto.randomUUID(), activeTurnBehavior: "steer", images: [], attachments: item.attachments.map((x: any) => x.attachment) }); }
      catch (e) { w.queues.set(agent, [item, ...(w.queues.get(agent) ?? [])]); throw e; }
    };
    const module = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    w.start = () => module.startChatAnnotations({ rpc: (contract: any, input: any) => contract.name === "tether.chat-reconcile" ? w.receiptRpc(input) : w.chatRpc(input) }, () => "fixture-generation", (() => {
      const hosts = new Map();
      return {
        update(key: string, input: HTMLTextAreaElement, panel: HTMLElement, label: string, visible: boolean) {
          let host = hosts.get(key);
          if (!host) { host = document.createElement('details'); host.dataset.tetherChat = 'collection-host'; const padded = document.createElement('div'); padded.style.padding = '12px'; padded.append(panel); host.append(document.createElement('summary'), padded); input.closest('[data-testid="message-input-root"]')!.before(host); hosts.set(key, host); }
          host.querySelector('summary').textContent = label; host.hidden = !visible;
        },
        remove(key: string) { hosts.get(key)?.remove(); hosts.delete(key); },
        dispose() { for (const host of hosts.values()) host.remove(); hosts.clear(); },
      };
    })());
    w.stop = w.start();
  }, { source, a, b });
  const input = page.locator('#a textarea[data-composer-input]');
  await page.waitForFunction(() => document.querySelector('#a summary')?.textContent?.includes("0 annotations"));
  await page.locator('#new textarea').fill("create"); await page.locator('#new textarea').press("Enter");
  assert.equal(await page.evaluate(() => (window as any).newSends), 1); assert.equal(await page.locator('#new [data-tether-chat]').count(), 0);
  await input.fill("ordinary"); await input.press("Enter"); await page.waitForFunction(() => (window as any).sent.length === 1);
  const select = async (key: string, index = 0) => {
    await page.evaluate(({ key, index }) => {
      const text = document.querySelectorAll(`#${key} [data-message-id] p`)[index].firstChild!;
      const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    }, { key, index });
    await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
  };
  await select("a");
  assert.equal(await page.locator('[data-tether-chat="menu"] button').count(), 2);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.locator('[data-tether-chat="card"] textarea').fill('cancel this draft');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(saved().drafts.length, 0);
  await select('a'); await page.getByRole('button', { name: 'Comment', exact: true }).click();
  assert.equal(await page.locator('[data-tether-chat="card"] header,[data-tether-chat="card"] blockquote').count(), 0);
  assert.equal(await page.locator('[data-tether-chat="card"] textarea').getAttribute('placeholder'), 'Comment...');
  // Compare actual reader and chat composers under the four reviewed palettes.
  const readerBuild = await Bun.build({ entrypoints: ['src/web/annotations-ui.ts'], target: 'browser' });
  if (!readerBuild.success) throw new Error(readerBuild.logs.join('\n'));
  const readerCss = (await Promise.all(['annotations-ui', 'theme-maker', 'thread-layout'].map(name => Bun.file(`src/web/${name}.css`).text()))).join('\n');
  await page.evaluate(async ({ source, css }) => {
    const w = window as any; w.previousThemeStyle = document.documentElement.getAttribute('style');
    const style = document.createElement('style'); style.id = 'reader-comparison'; style.textContent = css; document.head.prepend(style);
    const root = document.createElement('div'); root.id = 'reader-comparison-root'; document.body.append(root);
    const mod = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
    w.readerComparison = mod.createAnnotationUi({ root, editorRoot: root, getEditorView: () => null });
    w.readerComparison.openCommentComposer();
    document.documentElement.dataset.wmDesigned = 'true';
  }, { source: await readerBuild.outputs[0].text(), css: readerCss });
  for (const theme of ['tether', 'tether-dark', 'light-treason', 'dark-academia'] as const) {
    await page.evaluate(colors => {
      const style = document.documentElement.style;
      for (const [key, value] of Object.entries(colors)) style.setProperty(`--wm-color-${key}`, value);
      for (const [key, value] of Object.entries({ surface0: colors.background, surface1: colors.surface, foreground: colors['on-background'], 'foreground-muted': colors['on-surface-variant'] })) style.setProperty(`--colors-${key}`, value);
    }, themePresets[theme].colors);
    await page.waitForTimeout(600); // Adapter's theme refresh interval.
    const pair = await page.evaluate(() => {
      const properties = ['backgroundColor', 'color', 'borderTopColor', 'borderTopWidth', 'borderRadius', 'boxShadow', 'fontSize', 'fontFamily', 'padding', 'height'];
      return ['[data-tether-chat="card"]', '.wm-annotation-composer'].map(selector => {
        const root = document.querySelector(selector)!;
        return [root, root.querySelector('textarea')!, ...root.querySelectorAll('button')].map(node => {
          const css = getComputedStyle(node); return Object.fromEntries(properties.map(key => [key, (css as any)[key]]));
        });
      });
    });
    assert.deepEqual(pair[0], pair[1], `${theme}: reader and chat styles differ`);
  }
  await page.evaluate(() => {
    const w = window as any; w.readerComparison.destroy();
    document.querySelector('#reader-comparison')!.remove(); document.querySelector('#reader-comparison-root')!.remove();
    delete document.documentElement.dataset.wmDesigned;
    if (w.previousThemeStyle === null) document.documentElement.removeAttribute('style'); else document.documentElement.setAttribute('style', w.previousThemeStyle);
  });
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("first feedback");
  // Pointer dismissal and Enter race must include the completed save.
  await page.mouse.click(1040, 740); await input.fill("with annotation"); await input.press("Enter");
  await page.waitForFunction(() => (window as any).sent.length === 2);
  assert.equal(saved().drafts.length, 0);
  const sent = await page.evaluate(() => (window as any).sent[1]); assert.match(sent.text, /first feedback/); assert.equal(sent.options.images[0].data, "fixture-png");
  assert.equal(await page.locator('[data-tether-chat="card"]').count(), 0);
  // Empty feedback and no additional prose, while another chat retains its batch.
  await select("b"); await page.getByRole("button", { name: "Comment", exact: true }).click(); await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#b summary')?.textContent?.startsWith("1 annotation"));
  await select("a", 1); await page.getByRole("button", { name: "Comment", exact: true }).click(); await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#a summary')?.textContent?.startsWith("1 annotation"));
  await input.press("Enter"); await page.waitForFunction(() => (window as any).sent.length === 3);
  assert.equal(saved(b).drafts.length, 1); assert.equal(saved().drafts.length, 0);
  // Save failure stays open; a deliberate second dismissal retries the original card.
  failSave = true; await select("a"); await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("preserve me"); await page.mouse.click(1040, 740);
  await page.locator('[data-tether-chat="card"] [role="status"]').filter({ hasText: "fixture disk failure" }).waitFor();
  assert.equal(await page.getByRole("textbox", { name: "Comment", exact: true }).inputValue(), "preserve me");
  failSave = false; await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-tether-chat="card"]'));
  // Source-relative badge moves exactly with the text; card remains stationary.
  await page.locator('#a [data-tether-chat="badge"]').click();
  await page.locator('[data-tether-chat="card"] textarea').fill('cancel these edits');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(saved().drafts[0].feedback, 'preserve me');
  await page.locator('#a [data-tether-chat="badge"]').click();
  assert.equal(await page.locator('[data-tether-chat="card"] textarea').inputValue(), 'preserve me');
  const before = await page.locator('[data-tether-chat="card"]').boundingBox();
  const drift = await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('#a .scroll')!, badge = document.querySelector<HTMLElement>('#a [data-tether-chat="badge"]')!, text = document.querySelector('#a p')!;
    const start = badge.getBoundingClientRect().top - text.getBoundingClientRect().top;
    scroll.scrollTop = 37;
    return badge.getBoundingClientRect().top - text.getBoundingClientRect().top - start;
  });
  assert.equal(drift, 0); assert.equal((await page.locator('[data-tether-chat="card"]').boundingBox())!.y, before!.y);
  // Drag deliberately, preserve the preferred position, and clamp on resize.
  const header = await page.locator('[data-tether-chat="card"]').boundingBox();
  await page.mouse.move(header!.x + 4, header!.y + 4); await page.mouse.down(); await page.mouse.move(850, 650); await page.mouse.up();
  const dragged = await page.locator('[data-tether-chat="card"]').boundingBox(); assert.ok(dragged!.x > before!.x);
  await page.setViewportSize({ width: 800, height: 550 });
  await page.waitForFunction(() => { const r = document.querySelector('[data-tether-chat="card"]')!.getBoundingClientRect(); return r.right <= innerWidth - 8 && r.bottom <= innerHeight - 8; });
  const resized = await page.locator('[data-tether-chat="card"]').boundingBox(); assert.ok(resized!.x + resized!.width <= 792); assert.ok(resized!.y + resized!.height <= 542);
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => { const s = document.documentElement.style; s.setProperty("--colors-surface1", "#f1e5cf"); s.setProperty("--colors-surface0", "#fffaf0"); s.setProperty("--colors-foreground", "#30271a"); });
  assert.equal(await page.locator('[data-tether-chat="card"]').evaluate(e => getComputedStyle(e).backgroundColor), "rgb(241, 229, 207)");
  await page.screenshot({ path: "/tmp/tether-v1-card.png" });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.evaluate(() => { document.querySelector('#a .scroll')!.scrollTop = 0; (window as any).props.a.isAgentRunning = true; (window as any).props.a.defaultSendBehavior = "queue"; });
  await input.fill("queued prose"); await input.press("Enter"); await page.waitForFunction(a => (window as any).queues.get(a)?.length === 1, a);
  const batch = saved().submission!; assert.equal(batch.state, "prepared"); assert.equal(await page.evaluate(a => (window as any).queues.get(a)[0].id, a), batch.id);
  // Plugin reload and loss of native in-memory queue retain the saved batch identity.
  await page.evaluate(() => { const w = window as any; w.stop(); w.queues = new Map(); w.stop = w.start(); });
  await page.locator('#a summary').click(); await page.getByRole("button", { name: "Restore queued batch", exact: true }).click();
  await page.waitForFunction(a => (window as any).queues.get(a)?.length === 1, a);
  await page.evaluate(a => (window as any).drain(a), a);
  assert.equal(saved().submission, null); assert.equal(saved().drafts.length, 0);
  const queuedSent = await page.evaluate(() => (window as any).sent.at(-1)); assert.equal(queuedSent.text, batch.text); assert.equal(queuedSent.options.attachments.length, 1); assert.ok(!JSON.stringify(queuedSent).includes("tether-annotation-batch"));
  // Lost acceptance, reload, completed receipt and exact restored-composer cleanup.
  await page.evaluate(() => { const w = window as any; w.props.a.isAgentRunning = false; w.props.a.defaultSendBehavior = "steer"; w.lose = true; });
  await select("a"); await page.getByRole("button", { name: "Comment", exact: true }).click(); await page.mouse.click(1040, 740); await input.press("Enter");
  await page.waitForFunction(() => (window as any).lastError?.includes("lost acceptance"));
  const uncertain = saved().submission!; assert.equal(uncertain.state, "dispatching");
  await page.evaluate(() => { const w = window as any; w.stop(); w.stop = w.start(); });
  await page.locator('#a summary').click(); await page.getByRole("button", { name: "Check acceptance", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#a [aria-live]')?.textContent?.includes("Acceptance confirmed"));
  assert.equal(await input.inputValue(), ""); assert.equal(saved().drafts.length, 0);
  // Reconciliation must preserve text typed after the failed send.
  await page.evaluate(() => { (window as any).lose = true; (window as any).lastError = null; });
  await select("a", 1); await page.getByRole("button", { name: "Comment", exact: true }).click(); await page.mouse.click(1040, 740); await input.press("Enter");
  await page.waitForFunction(() => (window as any).lastError?.includes("lost acceptance"));
  await input.fill("newer unsent message");
  await page.getByRole("button", { name: "Check acceptance", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#a [aria-live]')?.textContent?.includes("Acceptance confirmed"));
  assert.equal(await input.inputValue(), "newer unsent message");
  // Missing/virtualized anchors retain drafts without falsely painting another row.
  await page.evaluate(() => { document.querySelector('#b [data-message-id]')!.remove(); });
  await page.waitForFunction(() => !document.querySelector('#b [data-tether-chat="badge"]'));
  assert.equal(saved(b).drafts.length, 1);
  await page.evaluate(b => (window as any).native.sendAgentMessage(b, "ordinary API message"), b);
  assert.equal(saved(b).drafts.length, 1);
  // Permanent deletion clears B, ordinary reads/reloads did not.
  await page.evaluate(b => (window as any).native.deleteAgent(b), b); assert.equal(saved(b).drafts.length, 0);
  // Wrapped inline text after inline code must place every badge at its quote.
  await page.evaluate(() => {
    const row = document.querySelector('#a [data-message-id]')!;
    row.innerHTML = '<p style="width:280px;font-size:22px">For the third selection, I can identify the selected text and its source as <code>user</code><span id="wrapped">, but I cannot tell from the selection alone whether it was ordinary prose or something else. The feedback field supplies that context.</span></p>';
    document.querySelector('#a .scroll')!.scrollTop = 0;
  });
  for (const word of ['selection', 'ordinary', 'context']) {
    await page.evaluate(async word => {
      const node = document.querySelector('#wrapped')!.firstChild!;
      const start = node.textContent!.indexOf(word), range = document.createRange();
      range.setStart(node, start); range.setEnd(node, start + word.length);
      const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      document.querySelector('#a .scroll')!.scrollTop += range.getBoundingClientRect().top - document.querySelector('#a .scroll')!.getBoundingClientRect().top - 70;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.dispatchEvent(new Event('selectionchange'));
    }, word);
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.getByRole('button', { name: 'Comment', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-tether-chat="card"]'));
    const delta = await page.evaluate(word => {
      const node = document.querySelector('#wrapped')!.firstChild!, range = document.createRange(), start = node.textContent!.indexOf(word);
      range.setStart(node, start); range.setEnd(node, start + word.length);
      const quote = range.getBoundingClientRect(), badge = [...document.querySelectorAll('#a [data-tether-chat="badge"]')].at(-1)!.getBoundingClientRect();
      return { x: badge.left - quote.left, y: badge.top - quote.top };
    }, word);
    assert.ok(Math.abs(delta.x) < 1 && Math.abs(delta.y + 9) < 1, `${word} badge misplaced: ${JSON.stringify(delta)}`);
  }
  await page.locator('#a [data-tether-chat="collection-host"]').evaluate(e => (e as HTMLDetailsElement).open = true);
  await page.getByRole('button', { name: 'Delete annotation 2', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('#a [data-tether-chat="badge"]').length === 2);
  assert.deepEqual(saved().drafts.map(d => d.quote), ['selection', 'context']);
  await page.getByRole('button', { name: 'Remove all annotations', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#a [data-tether-chat="badge"]'));
  assert.equal(saved().drafts.length, 0);
  // A submitted quote remains selectable, anchorable and sendable as a new annotation.
  await page.evaluate(text => {
    const row = document.querySelector('#a [data-message-id]')!;
    row.setAttribute('data-testid', 'user-message'); row.replaceChildren();
    const source = document.createElement('span'); source.dataset.messageText = 'true'; source.textContent = text; row.append(source);
    document.querySelector('#a .scroll')!.scrollTop = 0;
  }, formatDrafts([{ id: 'delivered', from: 'assistant', quote: 'A delivered passage.', feedback: 'First response.' }]));
  await page.locator('#a [data-tether-submitted]').waitFor();
  await page.evaluate(() => {
    const node = document.querySelector('#a [data-tether-submitted] blockquote p')!.firstChild!;
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.locator('[data-tether-chat="menu"]').getByRole('button', { name: 'Comment', exact: true }).click();
  await page.locator('[data-tether-chat="card"] textarea').fill('Commenting on the submitted quote.');
  await page.locator('[data-tether-chat="card"]').getByRole('button', { name: 'Comment', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-tether-chat="card"]'));
  assert.equal(saved().drafts[0].quote, 'A delivered passage.');
  assert.equal(saved().drafts[0].from, 'user');
  assert.equal(saved().drafts[0].anchor?.text, 'A delivered passage.');
  assert.equal(await page.locator('#a [data-tether-chat="badge"]').count(), 1);
  await input.fill(''); await input.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#a [data-tether-chat="badge"]'));
  assert.equal(saved().drafts.length, 0);
  assert.ok((await page.evaluate(() => (window as any).sent.at(-1).text)).includes('Commenting on the submitted quote.'));
  await page.evaluate(() => (window as any).stop());
  assert.equal(await page.locator('[data-tether-chat]').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).native.sendAgentMessage === (window as any).original), true);
  assert.deepEqual(errors, []);
  console.log("Paseo v1 browser checks passed: selection, cards, save failure/barrier, isolation, ordinary/empty sends, queue identity/reload, receipt cleanup, badge scrolling, deletion and teardown.");
} finally { await browser.close(); owner.close(); }
