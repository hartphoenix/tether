import { bodyRevision, createAnchor } from "../src/core/annotation-ledger";
import { chromium, webkit } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createDaemon } from '../src/server/server';
import { resolveConfig } from '../src/server/config';
import { createWebBundleResponder } from '../src/web/bundle';
import { decodePng } from '../src/documents/visual-png';
let remoteRequests = 0;
const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
        remoteRequests++;
        return new Response(Bun.file('src/web/favicon.png'), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600', ...(new URL(request.url).pathname === '/cors' ? { 'access-control-allow-origin': '*' } : {}) } });
    } });
const root = await mkdtemp('/tmp/tether-visual-capture-');
const bundle = await Bun.build({ entrypoints: ['src/web/visual-capture.ts'], target: 'browser', format: 'esm' });
const script = (await bundle.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, '');
const daemon = createDaemon({ config: resolveConfig({ runtimeDir: join(root, 'runtime'), configDir: join(root, 'config') }), web: await createWebBundleResponder() });
try {
    await daemon.ready;
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'local.png'), new Uint8Array(await Bun.file('src/web/favicon.png').arrayBuffer()));
    const path = join(root, 'docs', 'probe.md');
    await writeFile(path, '# Capture\n\n![Local](local.png)\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n');
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage();
            const errors: string[] = [];
            page.on('pageerror', e => { if (!e.message.includes('access control checks')) errors.push(e.message); });
            const enginePath = join(root, 'docs', `probe-${name}.md`);
            await writeFile(enginePath, '# Capture\n\n![Local](local.png)\n\n```mermaid\nflowchart LR\n A[Start] --> B[Finish]\n```\n');
            const grant = await daemon.service.open(enginePath);
            await page.goto(daemon.mintTicket(grant).url);
            await page.waitForSelector('.wm-mermaid svg');
            await page.addScriptTag({ content: script + '\nwindow.captureVisual=captureVisual;window.captureSvg=captureSvg;' });
            for (const selector of ['.wm-mermaid svg', '.milkdown-image-block img']) {
                const result = await page.evaluate(async (selector) => await (window as any).captureVisual(document.querySelector(selector)), selector);
                const png = decodePng(Buffer.from(result.png, 'base64'));
                if (png.width !== result.width)
                    throw Error('Incorrect captured dimensions');
                const second = await page.evaluate(async (selector) => {
                    const el = document.querySelector(selector) as HTMLElement;
                    el.style.width = '700px';
                    return (window as any).captureVisual(el);
                }, selector);
                if (second.layoutRevision !== result.layoutRevision)
                    throw Error('Presentation width changed layout identity');
            }
            const remountStable = await page.evaluate(async () => {
                const source=document.querySelector<SVGSVGElement>('.wm-mermaid svg')!;
                const before=await (window as any).captureVisual(source);
                let serialized=source.outerHTML;
                for(const el of [source,...source.querySelectorAll('[id]')]) if(el.id)serialized=serialized.replaceAll(el.id,'remounted-'+el.id);
                const clone=new DOMParser().parseFromString(serialized,'image/svg+xml').documentElement;
                source.parentElement!.append(clone);
                try { return (await (window as any).captureVisual(clone)).layoutRevision === before.layoutRevision; }
                finally { clone.remove(); }
            });
            if(!remountStable)throw Error('Mounted SVG IDs changed layout identity');
            if (await page.locator('.milkdown-code-block .wm-visual-comment svg').evaluate(el => getComputedStyle(el).fill) !== 'none') throw Error('Diagram comment icon must be outlined');
            for (const label of ['Expand diagram', 'image', 'Expand diagram']) {
                if (label === 'image')
                    await page.locator('.milkdown-image-block').hover();
                if (label === 'image')
                    await page.locator('.milkdown-image-block .wm-visual-comment').click();
                else
                    await page.locator('.milkdown-code-block .wm-visual-comment').click();
                const dialog = page.locator('dialog.wm-diagram-viewer');
                await dialog.getByRole('button', { name: 'Comment', exact: true }).waitFor();
                await page.waitForFunction(() => document.querySelector('.wm-region-overlay')?.getAttribute('style')?.includes('pointer-events: auto'));
                await dialog.locator('.wm-region-overlay').click({ position: { x: 4, y: 4 } });
                if (await dialog.locator('.wm-region-composer').count()) throw Error('A click created a region composer');
                const box = await dialog.locator('.wm-region-overlay').boundingBox();
                if (!box)
                    throw Error('No selection overlay');
                await page.mouse.move(box.x + box.width * .1, box.y + box.height * .1);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width * .6, box.y + box.height * .7, { steps: 5 });
                const drawing = await dialog.locator('.wm-region-overlay rect').evaluate(el => {
                    const probe=document.createElement('span');probe.style.color='var(--wm-color-selected, #8dc7e8)';document.body.append(probe);
                    const result={rx:el.getAttribute('rx'),stroke:getComputedStyle(el).stroke,expected:getComputedStyle(probe).color};probe.remove();return result;
                });
                if(drawing.rx !== '0' || drawing.stroke !== drawing.expected)throw Error('Drawing corners or selection color are incorrect');
                await page.mouse.up();
                const selected = await dialog.locator('.wm-region-overlay rect').evaluate(el => {
                    const probe=document.createElement('span');probe.style.color='var(--wm-color-annotation, #f1be5c)';document.body.append(probe);
                    const result={rx:Number(el.getAttribute('rx')),stroke:getComputedStyle(el).stroke,expected:getComputedStyle(probe).color};probe.remove();return result;
                });
                if(!(selected.rx > 0) || selected.stroke !== selected.expected)throw Error('Selected corners or annotation color are incorrect');
                await dialog.getByRole('textbox', { name: 'Comment', exact: true }).fill('Inspect this region');
                await dialog.locator('.wm-region-composer').getByRole('button', { name: 'Comment', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('.wm-visual-status')?.textContent === 'Saved');
                await page.keyboard.press('Escape');
                await dialog.waitFor({ state: 'detached' });
            }
            const snapshot = await daemon.service.read(grant);
            const threads = snapshot.annotations.threads! as import("../src/core/annotation-ledger").DerivedThread[];
            if (threads.length < 2)
                throw Error('Visual comments not persisted');
            for(const thread of threads.slice(-2)){const r=thread.anchor.visual!.region;if(Math.abs(r.x-.1)>.02||Math.abs(r.y-.1)>.02||Math.abs(r.width-.5)>.02||Math.abs(r.height-.6)>.02)throw Error('Selection geometry did not account for the content transform');}
            for (const thread of threads) {
                const overview = await daemon.service.visual(grant, thread.id);
                const pixels = decodePng(Buffer.from(await Bun.file(overview.artifact).arrayBuffer()));
                if (!pixels.width)
                    throw Error('Overview cannot be loaded');
                if (process.env.TETHER_VISUAL_ARTIFACT_DIR && thread.anchor.visual?.kind === 'mermaid') {
                    await mkdir(process.env.TETHER_VISUAL_ARTIFACT_DIR, { recursive: true });
                    await Bun.write(join(process.env.TETHER_VISUAL_ARTIFACT_DIR, `overview-${name}.png`), Bun.file(overview.artifact));
                }
            }
            await page.locator('.wm-visual-regions .wm-visual-badge').first().waitFor();
            for (const badge of await page.locator('.wm-visual-regions .wm-visual-badge').all()) {
                if (await badge.textContent() !== '1') throw Error('New visual threads must each show one message');
                const style = await badge.evaluate(el => { const s=getComputedStyle(el); return {background:s.backgroundColor, radius:s.borderRadius,width:s.width,height:s.height}; });
                if(style.background === 'rgba(0, 0, 0, 0)' || style.radius !== '999px' || style.width !== style.height) throw Error('Region badge must have a filled circular background');
            }
            const sizing = await page.evaluate(() => {
                const text = document.createElement('button'); text.className='wm-annotation-count';text.textContent='1';document.querySelector('.milkdown')!.append(text);
                const visual=document.querySelector('.wm-visual-badge')!;
                const dimensions=(el:Element)=>{const s=getComputedStyle(el);return [s.height,s.minWidth,s.fontSize,s.padding,s.borderRadius];};
                const results=[];
                for(const scale of [1,1.5]){document.documentElement.style.setProperty('--wm-ui-scale',String(scale));results.push([dimensions(text),dimensions(visual)]);}
                document.documentElement.style.setProperty('--wm-ui-scale','1');text.remove();return results;
            });
            for (const [text, visual] of sizing) if(JSON.stringify(text)!==JSON.stringify(visual))throw Error('Visual badge sizing differs from text badges');
            await page.locator('.milkdown-code-block .wm-visual-badge').first().click();
            const reopened = page.locator('dialog.wm-diagram-viewer');
            await reopened.locator('.wm-thread-card.is-active').waitFor();
            if (await reopened.locator('.wm-thread-card').count() !== 2) throw Error('Viewer drawer must contain both diagram threads and exclude the image thread');
            if (await reopened.getByRole('button', {name:'Close comment',exact:true}).count()) throw Error('Viewer drawer cards have close buttons');
            if (process.env.TETHER_VISUAL_ARTIFACT_DIR) await page.screenshot({path:join(process.env.TETHER_VISUAL_ARTIFACT_DIR, `drawer-${name}.png`), animations:'disabled'});
            const firstId = await reopened.locator('.wm-thread-card.is-active').getAttribute('data-thread-id');
            await reopened.locator('.wm-thread-card.is-active .wm-thread-summary').click();
            if (await reopened.locator('.wm-thread-card.is-active').count()) throw Error('Thread did not collapse');
            await reopened.locator(`.wm-thread-card:not([data-thread-id="${firstId}"]) .wm-thread-summary`).click();
            if (await reopened.locator('.wm-thread-card.is-active').count() !== 1) throw Error('Thread did not expand');
            await reopened.locator(`[data-thread-id="${firstId}"] .wm-thread-summary`).click();
            await reopened.locator('.wm-thread-card.is-active').getByRole('textbox', {name: /^Reply to /}).fill('Badge count reply');
            await reopened.locator('.wm-thread-card.is-active').getByRole('button', {name:'Reply',exact:true}).click();
            await page.waitForFunction(() => document.querySelector('.wm-diagram-stage .wm-visual-badge')?.textContent === '2');
            await reopened.getByRole('button', {name:'Hide threads',exact:true}).click();
            await reopened.locator('.wm-annotation-rail').waitFor({state:'hidden'});
            if (!await reopened.isVisible() || await reopened.locator('.wm-annotation-rail').isVisible()) throw Error('Closing comment should dismiss only the card');
            await reopened.locator('.wm-visual-badge').first().click();
            await reopened.getByRole('button', {name:'Hide threads',exact:true}).waitFor();
            const redraw = reopened.locator('.wm-diagram-controls').getByRole('button', { name: 'Redraw selection', exact: true });
            if (await redraw.isVisible()) throw Error('Unchanged visual offers redraw');
            if (await reopened.getByRole('button', {name:'Saved visual evidence',exact:true}).count()) throw Error('Evidence control remains');
            if (await reopened.locator('.wm-thread-quote, .wm-thread-context').count()) throw Error('Visual thread displays source quote');
            await page.setViewportSize({width:900,height:700});
            await page.waitForFunction(() => {
                const source=document.querySelector('.wm-diagram-stage > img, .wm-diagram-stage > svg:not(.wm-region-overlay)')!;
                const layer=document.querySelector('.wm-diagram-stage > .wm-visual-regions')!;
                const a=source.getBoundingClientRect(),b=layer.getBoundingClientRect();
                return Math.abs(a.x-b.x)<1 && Math.abs(a.y-b.y)<1 && Math.abs(a.width-b.width)<1;
            });
            await page.keyboard.press('Escape');
            await reopened.waitFor({state:'detached'});
            if (await page.locator('.wm-thread-popover').count()) throw Error('Escape left a visual comment card behind');
            await page.waitForFunction(() => document.querySelector('.milkdown-code-block .wm-visual-badge')?.textContent === '2');
            await page.locator('.milkdown-code-block .wm-visual-badge').first().click();
            await reopened.getByRole('button', {name:'Hide threads',exact:true}).waitFor();
            await reopened.getByRole('button', {name:'Close',exact:true}).click();
            await reopened.waitFor({state:'detached'});
            if (await page.locator('.wm-thread-popover').count()) throw Error('Closing viewer left a visual comment card behind');
            // A source edit should offer reattachment, while an unchanged visual must not.
            const beforeChange=await daemon.service.read(grant);
            await daemon.service.saveBody(grant, beforeChange.body.replace('A[Start]', 'A[Changed start]'), beforeChange.bodyRevision);
            await page.reload();
            await page.addScriptTag({ content: script + '\nwindow.captureVisual=captureVisual;window.captureSvg=captureSvg;' });
            await page.waitForSelector('.wm-mermaid svg');
            await page.locator('.wm-visual-fallback').first().click();
            await redraw.click();
            await page.waitForFunction(() => document.querySelector('.wm-visual-status')?.textContent === 'tap an element or draw a region, [esc] to cancel');
            await page.keyboard.press('Escape');
            if (!await reopened.isVisible())
                throw Error('Escape closed viewer before cancelling selection');
            await redraw.click();
            await page.waitForFunction(() => document.querySelector('.wm-visual-status')?.textContent === 'tap an element or draw a region, [esc] to cancel');
            const rb = await reopened.locator('.wm-region-overlay').boundingBox();
            if (!rb)
                throw Error('Missing redraw overlay');
            await page.mouse.move(rb.x + rb.width * .2, rb.y + rb.height * .2);
            await page.mouse.down();
            await page.mouse.move(rb.x + rb.width * .4, rb.y + rb.height * .4);
            await page.mouse.up();
            await page.waitForFunction(() => document.querySelector('.wm-visual-status')?.textContent === 'Saved');
            if (await redraw.isVisible()) throw Error('Redraw remains visible after successful reattachment');
            await reopened.locator('.wm-visual-badge').first().click();
            await reopened.locator('.wm-thread-card.is-active').getByRole('button', {name:'Resolve',exact:true}).click();
            await page.waitForFunction(() => document.querySelectorAll('.wm-visual-drawer .wm-thread-card').length === 1 && !document.querySelector('.wm-diagram-stage .wm-visual-badge') && document.querySelector('.wm-region-overlay rect')?.getAttribute('visibility')==='hidden');

            await page.keyboard.press('Escape');
            await reopened.waitFor({ state: 'detached' });
            const after = (await daemon.service.read(grant)).annotations.threads as import("../src/core/annotation-ledger").DerivedThread[];
            if (!after.some(t => t.anchorHistory.length))
                throw Error('Redraw lost history');
            const resolved = after.find(t=>t.anchorHistory.length)!;
            if (resolved.status !== 'resolved') throw Error('Resolve was not persisted');
            await page.locator('.wm-unresolved-filter').evaluate((button: HTMLButtonElement)=>button.click());
            await page.waitForFunction(id=>document.querySelector(`[data-thread-id="${id}"]`) !== null,resolved.id);
            await page.locator('.milkdown-code-block .wm-visual-badge').first().click();
            await page.locator('dialog.wm-diagram-viewer').getByRole('button',{name:'Reopen',exact:true}).waitFor();
            await page.keyboard.press('Escape');

            // Exercise both successful CORS display and normal display after CORS denial.
            const imageBundle = await Bun.build({ entrypoints: ['src/web/image-url.ts'], target: 'browser', format: 'esm' });
            const imageScript = (await imageBundle.outputs[0]!.text()).replace(/export\s*\{[^}]*\};?\s*$/, '');
            await page.addScriptTag({ content: imageScript + '\nwindow.loadImageDisplayUrl=loadImageDisplayUrl;' });
            for (const kind of ['cors', 'opaque']) {
                const before = remoteRequests;
                const result = await page.evaluate(async ({ url, kind }) => {
                    const img = new Image();
                    img.src = await (window as any).loadImageDisplayUrl(url);
                    await img.decode();
                    document.body.append(img);
                    const loaded = img.src;
                    let captured = false;
                    try {
                        await (window as any).captureVisual(img);
                        captured = true;
                    }
                    catch {
                    }
                    img.remove();
                    return { captured, loaded };
                }, { url: `http://127.0.0.1:${remote.port}/${kind}`, kind });
                if (result.captured !== (kind === 'cors'))
                    throw Error('Incorrect direct capture capability');
                const afterLoad = remoteRequests;
                await page.evaluate(async (url) => {
                    const img = new Image();
                    img.src = url;
                    await img.decode();
                    try {
                        await (window as any).captureVisual(img);
                    }
                    catch {
                    }
                }, result.loaded);
                if (remoteRequests !== afterLoad)
                    throw Error('Annotation capture refetched a remote image');
                if (afterLoad === before && name === 'chromium')
                    throw Error('CORS probe did not request its fixture');
            }
            const textPath=join(root,'docs',`text-${name}.md`),textBody='Old quote.\n\nReplacement text.\n';
            await writeFile(textPath,textBody);const textGrant=await daemon.service.open(textPath);
            const textCreated=await daemon.service.appendEvent({session:textGrant,type:'comment',actor:'human',body:'Reattach this',anchor:createAnchor('Old quote.\nReplacement text.',0,10,bodyRevision(textBody)),expectedBodyRevision:bodyRevision(textBody)});
            const textId=(textCreated.annotations.threads[0] as {id:string}).id;
            await daemon.service.saveBody(textGrant,textBody.replace('Old quote.','Changed passage.'),bodyRevision(textBody));
            await page.goto(daemon.mintTicket(textGrant).url);await page.waitForSelector('.ProseMirror p');
            await page.locator('#comment').click();await page.locator('.wm-orphan-group .wm-thread-summary').click();
            await page.getByRole('button',{name:'Reselect text',exact:true}).click();
            await page.keyboard.press('Escape');
            if(await page.locator('.wm-reselecting').count())throw Error('Text reselection did not cancel');
            await page.getByRole('button',{name:'Reselect text',exact:true}).click();
            const textBox=await page.locator('.ProseMirror p').nth(1).evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const b=range.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};});
            await page.mouse.move(textBox.x+1,textBox.y+textBox.height/2);await page.mouse.down();await page.mouse.move(textBox.x+textBox.width-1,textBox.y+textBox.height/2,{steps:6});await page.mouse.up();
            await page.waitForFunction(()=>!document.querySelector('.wm-reselecting'));
            const reattached=await daemon.service.thread(textGrant,textId);if(!reattached.thread.anchor.exact.includes('Replacement')||reattached.thread.anchorHistory.length!==1)throw Error('Text reselection lost its thread or anchor history');
            const checkboxPath=join(root,'docs',`checkbox-${name}.md`);
            await writeFile(checkboxPath, 'Comment this passage.\n\n- [ ] Toggle after commenting\n');
            const checkboxGrant=await daemon.service.open(checkboxPath);
            await page.goto(daemon.mintTicket(checkboxGrant).url);
            const passage=page.locator('.ProseMirror p').first();
            await passage.waitFor();
            const bounds=await passage.evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);const b=r.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};});
            await page.mouse.move(bounds.x+1,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width-1,bounds.y+bounds.height/2,{steps:6});await page.mouse.up();
            await page.locator('[data-toolbar-item="comment"]').click();
            const composer=page.locator('.wm-annotation-composer');
            await composer.locator('textarea').fill('Checkbox selection regression');
            await composer.getByRole('button',{name:'Comment',exact:true}).click();
            await composer.waitFor({state:'detached'});
            await page.locator('.milkdown-list-item-block .label-wrapper').click();
            if(await page.evaluate(()=>Boolean(window.getSelection()?.toString()))) throw Error('Checkbox restored the commented text selection');
            if(!await page.locator('.wm-annotation-highlight').count()) throw Error('Checkbox removed the annotation highlight');
            if(errors.length)throw Error(errors.join('\n'));
            console.log(`${name}: capture, stable identity, region comments, redraw, CORS limits, and text reattachment passed`);
        }
        finally {
            await browser.close();
        }
    }
}
finally {
    remote.stop(true);
    await daemon.stop();
    await rm(root, { recursive: true, force: true });
}
