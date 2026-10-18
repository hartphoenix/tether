/** Host-independent visual coordinates and resource boundaries. */
export const VISUAL_LIMITS = { dimension: 4096, pixels: 8000000, bytes: 8 * 1024 * 1024, overview: 1200, regions: 12, svgBytes: 16 * 1024 * 1024, svgElements: 10000, targets: 32 } as const;
export type Region = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type VisualAnchor = {
    version: 1;
    kind: "image" | "mermaid";
    source: string;
    occurrences: number;
    sourceRevision?: string;
    layoutRevision: string;
    evidence: string;
    width: number;
    height: number;
    viewBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    region: Region;
    /** Diagram elements the region covers, as `<pele class>:<data-id>`; they survive relayout. */
    targets?: string[];
    /** For a drawn region, the targets' box when it was drawn; the region keeps its shape around them. */
    targetBox?: Region;
};
export function validateRegion(value: Region): Region {
    if (!value || ![value.x, value.y, value.width, value.height].every(Number.isFinite)
        || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
        || value.x + value.width > 1 || value.y + value.height > 1)
        throw new Error("Region must have positive area within the visual.");
    return { x: value.x, y: value.y, width: value.width, height: value.height };
}
export function validateVisual(value: VisualAnchor): VisualAnchor {
    if (!value || value.version !== 1 || !["image", "mermaid"].includes(value.kind)
        || !Number.isSafeInteger(value.occurrences) || value.occurrences < 1
        || typeof value.source !== "string" || value.source.length > 65536
        || !/^sha256:[a-f0-9]{64}$/.test(value.layoutRevision) || !/^sha256:[a-f0-9]{64}$/.test(value.evidence))
        throw new Error("Unsupported or invalid visual anchor.");
    if (value.sourceRevision !== undefined && !/^sha256:[a-f0-9]{64}$/.test(value.sourceRevision))
        throw new Error("Invalid source revision.");
    // Demo anchors saved a single `target` before multi-element regions.
    const legacy = (value as { target?: unknown }).target;
    const targets = value.targets ?? (legacy === undefined ? undefined : [legacy]);
    if (targets !== undefined && (!Array.isArray(targets) || !targets.length || targets.length > VISUAL_LIMITS.targets
        || !targets.every(t => typeof t === "string" && /^[a-z][a-z-]*:.{1,512}$/s.test(t))))
        throw new Error("Invalid visual targets.");
    validateDimensions(value.width, value.height);
    const b = value.viewBox;
    if (b && (![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0))
        throw new Error("Invalid SVG viewBox.");
    return { version: 1, kind: value.kind, source: value.source, occurrences: value.occurrences, ...(value.sourceRevision ? { sourceRevision: value.sourceRevision } : {}), layoutRevision: value.layoutRevision, evidence: value.evidence, width: value.width, height: value.height, ...(b ? { viewBox: { ...b } } : {}), region: validateRegion(value.region), ...(targets ? { targets: [...targets] as string[] } : {}), ...(targets && value.targetBox ? { targetBox: validateRegion(value.targetBox) } : {}) };
}
export function validateDimensions(width: number, height: number): void {
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= VISUAL_LIMITS.dimension) || width * height > VISUAL_LIMITS.pixels)
        throw new Error("Visual exceeds capture limits (4096 pixels per side, 8 million pixels).");
}
export type VisualBlock = {
    kind: VisualAnchor['kind'];
    source: string;
    start: number;
    end: number;
};
/** Source identity locates unique moves; context distinguishes duplicates and replacements. */
export function locateVisualBlock(anchor: import('./annotation-ledger').AnnotationAnchor, projection: string, blocks: VisualBlock[], revision?: string): VisualBlock | null {
    const visual = anchor.visual;
    if (!visual)
        return null;
    const compatible = blocks.filter(b => b.kind === visual.kind);
    if (revision === anchor.bodyRevision) {
        const exact = compatible.find(b => b.start === anchor.projectionStart && b.end === anchor.projectionEnd && b.source === visual.source);
        if (exact)
            return exact;
    }
    const context = (b: VisualBlock) => projection.slice(0, b.start).endsWith(anchor.prefix) && projection.slice(b.end).startsWith(anchor.suffix);
    const same = compatible.filter(b => b.source === visual.source);
    if (same.length === 1 && visual.occurrences === 1)
        return same[0]!;
    const contextual = (same.length ? same : compatible).filter(context);
    return contextual.length === 1 ? contextual[0]! : null;
}
