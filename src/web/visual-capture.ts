import { validateDimensions, VISUAL_LIMITS } from "../core/visual-anchor";
export async function visualHash(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return 'sha256:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))].map(n => n.toString(16).padStart(2, '0')).join('');
}
/** Freeze computed SVG styles before export. Mounted IDs and viewer transforms are not layout identity. */
export async function captureSvg(source: SVGSVGElement): Promise<string> {
    if (source.querySelector("foreignObject, image"))
        throw new Error("This diagram contains content that cannot be captured directly.");
    if (source.querySelectorAll("*").length > VISUAL_LIMITS.svgElements || source.outerHTML.length > VISUAL_LIMITS.svgBytes)
        throw new Error("Diagram exceeds the SVG capture limit.");
    // Hover tracing is presentation, not layout; capture the diagram untraced.
    const traced = source.classList.contains('wm-trace');
    source.classList.remove('wm-trace');
    try {
        return await captureUntraced(source);
    }
    finally {
        if (traced)
            source.classList.add('wm-trace');
    }
}
async function captureUntraced(source: SVGSVGElement): Promise<string> {
    const clone = source.cloneNode(true) as SVGSVGElement;
    for (const el of clone.querySelectorAll('.is-traced, .is-neighbor'))
        el.classList.remove('is-traced', 'is-neighbor');
    const originals = [source, ...source.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    const ids = new Map<string, string>();
    originals.forEach(el => {
        if (el.id)
            ids.set(el.id, `visual-${ids.size}`);
    });
    const properties = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'rx', 'ry', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'color'];
    copies.forEach((el, i) => {
        const style = getComputedStyle(originals[i]!);
        el.removeAttribute('style');
        for (const key of properties)
            (el as SVGElement).style.setProperty(key, style.getPropertyValue(key));
        for (const attr of [...el.attributes]) {
            if (attr.name === 'id')
                attr.value = ids.get(attr.value)!;
            else if (attr.name === 'aria-labelledby' || attr.name === 'aria-describedby')
                attr.value = attr.value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ');
            else if (attr.localName === 'href' && attr.value.startsWith('#'))
                attr.value = '#' + (ids.get(attr.value.slice(1)) ?? attr.value.slice(1));
            else
                attr.value = attr.value.replace(/url\(["']?(?:[^#)]*)#([^"')]+)["']?\)/g, (_, id) => `url(#${ids.get(id) ?? id})`);
        }
    });
    clone.style.backgroundColor = visualBackground(source);
    clone.querySelectorAll('style').forEach(el => el.remove());
    const fontStyle = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    fontStyle.textContent = await embeddedFonts(new Set(originals.map(el => getComputedStyle(el).fontFamily)));
    clone.prepend(fontStyle);
    const b = source.viewBox.baseVal;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(b.width));
    clone.setAttribute('height', String(b.height));
    const serialized = new XMLSerializer().serializeToString(clone);
    if (new TextEncoder().encode(serialized).length > VISUAL_LIMITS.svgBytes)
        throw new Error("Styled diagram exceeds 16 MiB.");
    return serialized;
}
export async function captureVisual(source: SVGSVGElement | HTMLImageElement) {
    const image = source instanceof HTMLImageElement;
    const box = image ? undefined : source.viewBox.baseVal;
    const width = Math.ceil(image ? source.naturalWidth : box!.width), height = Math.ceil(image ? source.naturalHeight : box!.height);
    validateDimensions(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    let layout: string | undefined;
    if (image)
        context.drawImage(source, 0, 0, width, height);
    else {
        layout = await captureSvg(source);
        context.fillStyle = visualBackground(source);
        context.fillRect(0, 0, width, height);
        const url = URL.createObjectURL(new Blob([layout], { type: 'image/svg+xml' }));
        try {
            const rendered = new Image();
            rendered.src = url;
            await rendered.decode();
            context.drawImage(rendered, 0, 0, width, height);
        }
        finally {
            URL.revokeObjectURL(url);
        }
    }
    let png: string;
    try {
        png = canvas.toDataURL('image/png').split(',')[1]!;
    }
    catch {
        throw new Error('This image can be viewed, but browser permissions prevent region capture.');
    }
    if (png.length * .75 > VISUAL_LIMITS.bytes)
        throw new Error('Captured evidence exceeds 8 MiB.');
    const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
    return { png, width, height, evidence: await visualHash(bytes), layoutRevision: await visualHash(layout ? canonicalSvgLayout(layout) : bytes), ...(box ? { viewBox: { x: box.x, y: box.y, width: box.width, height: box.height } } : {}) };
}
const fonts = new Map<string, Promise<string>>();
let fontBytes = 0;
async function embeddedFonts(families: Set<string>): Promise<string> {
    const used = [...families].join(',').replaceAll('"', '').replaceAll("'", '').split(',').map(s => s.trim());
    const rules: CSSFontFaceRule[] = [];
    const collect = (list: CSSRuleList) => {
        for (const rule of list) {
            if (rule.type === CSSRule.FONT_FACE_RULE) {
                const font = rule as CSSFontFaceRule;
                if (used.includes(font.style.fontFamily.replace(/["']/g, '')))
                    rules.push(font);
            }
            else if ('cssRules' in rule)
                collect((rule as CSSGroupingRule).cssRules);
        }
    };
    for (const sheet of document.styleSheets) {
        try {
            collect(sheet.cssRules);
        }
        catch {
            throw new Error('Diagram font styles cannot be exported by this browser.');
        }
    }
    const css: string[] = [];
    for (const rule of rules) {
        let text = rule.cssText;
        for (const match of text.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
            const url = new URL(match[1]!, rule.parentStyleSheet?.href ?? document.baseURI).href;
            let pending = fonts.get(url);
            if (!pending) {
                pending = (async () => {
                    const response = await fetch(url, { mode: 'cors', credentials: 'same-origin', signal: AbortSignal.timeout(15000) });
                    if (!response.ok)
                        throw Error('Diagram font capture failed.');
                    const bytes = new Uint8Array(await response.arrayBuffer());
                    if (bytes.length > 2 * 1024 * 1024 || fontBytes + bytes.length > 8 * 1024 * 1024)
                        throw Error('Diagram fonts exceed capture limits.');
                    fontBytes += bytes.length;
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192)
                        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
                    return 'data:font/woff2;base64,' + btoa(binary);
                })();
                fonts.set(url, pending);
                pending.catch(() => fonts.delete(url));
            }
            text = text.replace(match[0], `url("${await pending}")`);
        }
        css.push(text);
    }
    return css.join('\n');
}

/** XML namespace placement and attribute ordering are serialization details. */
function canonicalSvgLayout(svg: string): string {
    const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    const node = (element: Node): unknown => {
        if (element.nodeType !== Node.ELEMENT_NODE) return element.textContent;
        const el = element as Element;
        const attributes = [...el.attributes]
            .filter(attribute => attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
            .map(attribute => [attribute.namespaceURI ?? '', attribute.localName, attribute.value])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return [el.localName, attributes, [...el.childNodes].map(node)];
    };
    return JSON.stringify(node(root));
}

function visualBackground(source: Element): string {
    for (let element: Element | null = source; element; element = element.parentElement) {
        const color = getComputedStyle(element).backgroundColor;
        if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
    }
    return '#ffffff';
}
