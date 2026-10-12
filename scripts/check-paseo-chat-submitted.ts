/** Real React reconciliation and Paseo 0.11.2's unmodified UserMessage body.
 * Host widgets are small DOM stand-ins; desktop appearance remains a human check. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium, webkit } from "playwright";
import { formatDrafts } from "../integrations/paseo/chat/model";

const sourceRoot = process.argv[2] ?? "/tmp/tether-paseo-v0112-probe";
assert.equal(Bun.spawnSync(["git", "-C", sourceRoot, "rev-parse", "HEAD"]).stdout.toString().trim(), "75953250959979b8f088bbca8dbd6ee61d0151b1");
const messageSource = await Bun.file(`${sourceRoot}/packages/app/src/components/message.tsx`).text();
const native = messageSource.slice(messageSource.indexOf("function UserMessageImagePill("), messageSource.indexOf("interface AssistantTurnFooterProps"));
assert.ok(native.includes('dataSet={MESSAGE_TEXT_DATASET}'));
const entry = `
import React, { memo, useCallback, useMemo, useState } from ${JSON.stringify(resolve("node_modules/react"))};
import { createRoot } from ${JSON.stringify(resolve("node_modules/react-dom/client"))};
import { startSubmittedAnnotations } from ${JSON.stringify(resolve("integrations/paseo/chat/submitted-ui.ts"))};
import { readSelection, findAnchor } from ${JSON.stringify(resolve("integrations/paseo/chat/dom.ts"))};
import { findRenderedMatches } from ${JSON.stringify(`${sourceRoot}/packages/app/src/agent-stream/chat-find/ranges.web.ts`)};
import { applyRootUiFont } from ${JSON.stringify(`${sourceRoot}/packages/app/src/appearance/apply-root-font.web.ts`)};
applyRootUiFont('sans-serif');
const w = window;
const flatten = style => Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : style;
function View({ testID, dataSet, style, children, onPointerEnter, onPointerLeave, ...rest }) {
  return <div data-testid={testID} style={flatten(style)} onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>{children}</div>;
}
function Text({ testID, dataSet, style, children }) {
  return <span data-testid={testID} data-message-text={dataSet?.messageText} style={flatten(style)}>{children}</span>;
}
const useIsCompactFormFactor = () => true, isNative = false;
const useTranslation = () => ({t: key => key});
const useDisableOuterSpacing = () => true;
const formatMessageTimestamp = () => '12:30';
const useRewindAgentMutation = () => ({isPending:false, rewindAgent: input => {w.rewound = input.rewoundText;}});
const userMessageStylesheet = {text:{fontSize:16,lineHeight:'24px',color:'var(--colors-foreground)'}, bubble:{padding:16,background:'var(--colors-surface1)',borderRadius:16}, trailingRow:{display:'flex',gap:8,marginTop:8}};
const getAgentAttachmentPillContent = attachment => ({title:attachment.name});
function AttachmentFrame({onPress,accessibilityLabel,children}) { return onPress ? <button aria-label={accessibilityLabel} onClick={onPress}>{children}</button> : <div>{children}</div>; }
const AttachmentThumbnail = ({metadata}) => <span>{metadata.name}</span>;
const AttachmentLabel = ({title}) => <span>{title}</span>;
const AttachmentLightbox = ({source,onClose}) => source ? <div role="dialog">{source.metadata.name}<button onClick={onClose}>Close image</button></div> : null;
const TurnCopyButton = ({getContent}) => <button onClick={() => {w.copied = getContent();}}>Copy message</button>;
const RewindMenu = ({onRewind,rewoundText}) => <button onClick={() => onRewind({mode:'edit',rewoundText})}>Rewind</button>;
${native}
const root = createRoot(document.getElementById('root'));
w.render = (message, extra = {}) => root.render(<div data-message-id="submitted"><UserMessage serverId="host" agentId="agent" messageId="submitted" message={message} timestamp={new Date()} capabilities={{}} client={{}} images={[{id:'image',name:'image.png'}]} attachments={[{type:'uploaded_file',name:'notes.txt'}]} {...extra}/></div>);
w.unmount = () => root.unmount();
w.start = () => startSubmittedAnnotations();
w.select = selector => {
  const element = document.querySelector(selector), range = document.createRange();
  range.selectNodeContents(element.firstChild);
  const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const passage = readSelection();
  return passage ? {draft:passage.draft, found:passage.draft.anchor && findAnchor(document.querySelector('[data-testid="agent-chat-scroll"]'), passage.draft.anchor)?.toString()} : null;
};
w.find = query => findRenderedMatches(document.querySelector('[data-message-id]'), query).map(range => range.toString());
const input = document.querySelector('textarea');
Reflect.set(input, '__reactFiber$fixture', {memoizedProps:{voiceServerId:'host',voiceAgentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',attachments:[],onSubmit(){},client:{sendAgentMessage(){},fetchAgentTimeline(){}}}});
`;
const build = await Bun.build({ entrypoints: ["fixture:submitted"], target: "browser", plugins: [{ name: "fixture", setup(build) {
  build.onResolve({ filter: /^fixture:/ }, args => ({ path: args.path, namespace: "fixture" }));
  build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: entry, loader: "tsx", resolveDir: process.cwd() }));
} }] });
if (!build.success) throw new Error(build.logs.join("\n"));
const source = await build.outputs[0].text();
const wire = `Before the quotes.\n\n${formatDrafts([
  { id: "1", from: "assistant", quote: "A selected passage.", feedback: "My feedback." },
  { id: "2", from: "user", quote: 'const text = "</chat-selection>";', code: "ts", feedback: "" },
  { id: "3", quote: "Unattributed quote.", feedback: '<img src=x onerror="alert(1)"> literal text.' },
  { id: "4", quote: "Tool output line.", code: true, feedback: "" },
])}\n\nAfter the quotes.`;

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 850, height: 1000 } });
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("http://localhost/submitted", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await page.goto("http://localhost/submitted");
    await page.setContent(`<style>:root {--colors-foreground:#ddd;--colors-foreground-muted:#aaa;--colors-accent:#6ec0b8;--colors-surface1:#292d32} body {background:#202428;color:var(--colors-foreground);font:16px system-ui} #pane {width:600px;margin:30px auto} [data-testid="agent-chat-scroll"] {height:800px;overflow:auto} button {margin:4px;padding:6px}</style><div id="pane"><div data-testid="agent-chat-scroll"><div id="root"></div></div><textarea data-composer-input></textarea></div>`);
    await page.evaluate(async ({ source, wire }) => { await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" }))); const w = window as any; w.display = w.start(); w.render(wire); }, { source, wire });
    const view = page.locator('[data-tether-submitted]');
    await view.waitFor();
    assert.deepEqual(await view.locator('.tether-submitted-speaker').allTextContents(), ["Assistant", "Code", "Selected passage", "Code"]);
    assert.equal(await view.locator('section').count(), 4);
    assert.equal(await view.locator('.tether-submitted-feedback').count(), 2);
    assert.equal(await view.locator('img').count(), 0, "annotation content is text, never HTML");
    for (const font of await view.locator('pre').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fontFamily)))
      assert.match(font, /monospace/, "code keeps its font under Paseo's global UI font rule");
    assert.equal(await view.locator('.tether-submitted-feedback').first().evaluate(node => getComputedStyle(node).fontFamily), 'sans-serif');
    assert.equal(await view.locator(':scope > p').first().textContent(), 'Before the quotes.');
    assert.equal(await view.locator(':scope > p').last().textContent(), 'After the quotes.');
    assert.equal(await page.locator('[data-tether-submitted-source]').isVisible(), false);
    assert.equal(await page.locator('[data-tether-submitted-source]').textContent(), wire);
    // Native controls and attachment state survive; no replacement of the UserMessage component.
    await page.getByRole('button', { name: 'composer.attachments.openImage' }).click();
    assert.equal(await page.getByRole('dialog').textContent(), 'image.pngClose image');
    await page.getByRole('button', { name: 'Close image' }).click();
    assert.equal(await page.getByText('notes.txt', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: 'Copy message', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).copied), wire);
    await page.getByRole('button', { name: 'Rewind', exact: true }).click();
    assert.equal(await page.evaluate(() => (window as any).rewound), wire);
    // Selection and anchors use the readable text exactly once, with the enclosing turn's speaker.
    for (const [selector, quote, code] of [
      ['blockquote p', 'A selected passage.', undefined],
      ['.tether-submitted-feedback', 'My feedback.', undefined],
      ['pre', 'const text = "</chat-selection>";', 'ts'],
      ['> p', 'Before the quotes.', undefined],
    ] as const) {
      const selection = await page.evaluate(selector => (window as any).select(`[data-tether-submitted] ${selector}`), selector);
      assert.equal(selection?.draft.quote, quote); assert.equal(selection?.found, quote);
      assert.equal(selection?.draft.from, 'user'); assert.equal(selection?.draft.code, code);
    }
    assert.deepEqual(await page.evaluate(() => (window as any).find('My feedback.')), ['My feedback.']);
    assert.deepEqual(await page.evaluate(() => (window as any).find('feedback:')), []);
    await page.screenshot({ path: `/tmp/tether-submitted-${engine.name()}.png` });
    // Theme changes, original React node updates, attachment changes and recycled rows.
    await page.evaluate(() => { document.documentElement.style.setProperty('--colors-foreground', '#202020'); (window as any).display.refresh(); });
    assert.equal(await view.evaluate(node => getComputedStyle(node).color), 'rgb(32, 32, 32)');
    await page.evaluate(wire => (window as any).render(wire.replace('My feedback.', 'Edited feedback.'), { images: [] }), wire);
    await page.waitForFunction(() => document.querySelector('[data-tether-submitted]')?.textContent?.includes('Edited feedback.'));
    assert.equal(await view.count(), 1);
    assert.equal(await page.getByRole('button', { name: 'composer.attachments.openImage' }).count(), 0);
    const malformed = `${wire}\n<chat-selection>\n broken`;
    await page.evaluate(text => (window as any).render(text), malformed);
    await page.waitForFunction(() => !document.querySelector('[data-tether-submitted]'));
    assert.equal(await page.locator('[data-message-text]').textContent(), malformed);
    assert.equal(await page.locator('[data-message-text]').isVisible(), true);
    await page.evaluate(() => (window as any).render('Ordinary message'));
    await page.waitForFunction(() => document.querySelector('[data-message-text]')?.textContent === 'Ordinary message');
    await page.evaluate(wire => (window as any).render(wire), wire); await view.waitFor();
    await page.evaluate(() => (window as any).display.dispose());
    assert.equal(await view.count(), 0);
    assert.equal(await page.locator('[data-message-text]').isVisible(), true);
    assert.equal(await page.locator('[data-message-text]').getAttribute('aria-hidden'), null);
    assert.equal(await page.locator('[data-message-text]').textContent(), wire);
    await page.evaluate(() => { const w = window as any; w.display = w.start(); }); await view.waitFor();
    await page.evaluate(() => (window as any).unmount());
    await page.waitForFunction(() => !document.querySelector('[data-tether-submitted]'));
    await page.evaluate(() => (window as any).display.dispose());
    assert.deepEqual(errors, []);
    console.log(`${engine.name()}: submitted annotations passed native UserMessage rerenders, attachment controls, whole-message copy/rewind, selection, code attribution, anchors, find, malformed fallback, theme and teardown checks.`);
  } finally { await browser.close(); }
}
