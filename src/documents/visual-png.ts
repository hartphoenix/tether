import { deflateSync, inflateSync } from 'node:zlib';
import { validateDimensions, VISUAL_LIMITS, type Region } from '../core/visual-anchor';
type Pixels = {
    width: number;
    height: number;
    data: Uint8Array;
};
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (const b of bytes) {
        c ^= b;
        for (let j = 0; j < 8; j++)
            c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(type, 4);
    b.set(data, 8);
    b.writeUInt32BE(crc(b.subarray(4, -4)), b.length - 4);
    return b;
}
export function encodePng(p: Pixels): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(p.width);
    header.writeUInt32BE(p.height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc((p.width * 4 + 1) * p.height);
    for (let y = 0; y < p.height; y++)
        rows.set(p.data.subarray(y * p.width * 4, (y + 1) * p.width * 4), y * (p.width * 4 + 1) + 1);
    return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}
/** Accept bounded, non-interlaced 8-bit RGB/RGBA canvas PNGs only. */
export function decodePng(bytes: Buffer): Pixels {
    if (bytes.length > VISUAL_LIMITS.bytes || !bytes.subarray(0, 8).equals(signature))
        throw Error('Invalid or oversized PNG evidence.');
    let width = 0, height = 0, channels = 0, ended = false;
    const parts: Buffer[] = [];
    for (let i = 8; i < bytes.length;) {
        if (i + 12 > bytes.length)
            throw Error('Truncated PNG.');
        const n = bytes.readUInt32BE(i), type = bytes.toString('ascii', i + 4, i + 8);
        if (i + n + 12 > bytes.length || crc(bytes.subarray(i + 4, i + 8 + n)) !== bytes.readUInt32BE(i + 8 + n))
            throw Error('Invalid PNG chunk.');
        const d = bytes.subarray(i + 8, i + 8 + n);
        if (type === 'IHDR') {
            if (width || n !== 13)
                throw Error('Invalid PNG header.');
            width = d.readUInt32BE(0);
            height = d.readUInt32BE(4);
            validateDimensions(width, height);
            channels = d[9] === 6 ? 4 : d[9] === 2 ? 3 : 0;
            if (d[8] !== 8 || !channels || d[10] || d[11] || d[12])
                throw Error('Unsupported PNG encoding.');
        }
        else if (type === 'IDAT')
            parts.push(d);
        else if (type === 'IEND') {
            ended = true;
            break;
        }
        i += n + 12;
    }
    if (!width || !ended)
        throw Error('Incomplete PNG.');
    const stride = width * channels, raw = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
    if (raw.length !== (stride + 1) * height)
        throw Error('Invalid PNG pixels.');
    const decoded = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)]!;
        if (filter > 4)
            throw Error('Invalid PNG filter.');
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? decoded[y * stride + x - channels]! : 0, b = y ? decoded[(y - 1) * stride + x]! : 0, c = y && x >= channels ? decoded[(y - 1) * stride + x - channels]! : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            decoded[y * stride + x] = (raw[y * (stride + 1) + 1 + x]! + predictor) & 255;
        }
    }
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data.set(decoded.subarray(i * channels, i * channels + 3), i * 4);
        data[i * 4 + 3] = channels === 4 ? decoded[i * channels + 3]! : 255;
    }
    return { width, height, data };
}
const digits = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111', '111100111101111', '111001001001001', '111101111101111', '111101111001111'];
export function renderEvidence(base: Pixels, regions: Region[], mode: 'overview' | 'crop' | 'clean'): Buffer {
    if (mode === 'clean')
        return encodePng(base);
    const crop = mode === 'crop' ? regions[0]! : { x: 0, y: 0, width: 1, height: 1 };
    const sx = Math.floor(crop.x * base.width), sy = Math.floor(crop.y * base.height), sw = Math.max(1, Math.ceil(crop.width * base.width)), sh = Math.max(1, Math.ceil(crop.height * base.height));
    const scale = mode === 'overview' ? Math.min(1, VISUAL_LIMITS.overview / Math.max(sw, sh)) : 1;
    const width = Math.max(1, Math.round(sw * scale)), height = Math.max(1, Math.round(sh * scale)), data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const i = (Math.min(base.height - 1, sy + Math.floor(y / scale)) * base.width + Math.min(base.width - 1, sx + Math.floor(x / scale))) * 4;
            data.set(base.data.subarray(i, i + 4), (y * width + x) * 4);
        }
    const pixel = (x: number, y: number, r: number, g: number, b: number) => {
        if (x < 0 || y < 0 || x >= width || y >= height)
            return;
        data.set([r, g, b, 255], (y * width + x) * 4);
    };
    if (mode === 'overview')
        regions.forEach((r, index) => {
            const x0 = Math.floor(r.x * width), y0 = Math.floor(r.y * height), x1 = Math.min(width - 1, Math.ceil((r.x + r.width) * width)), y1 = Math.min(height - 1, Math.ceil((r.y + r.height) * height));
            for (let y = y0; y <= y1; y++)
                for (let x = x0; x <= x1; x++) {
                    if (x - x0 < 2 || x1 - x < 2 || y - y0 < 2 || y1 - y < 2)
                        pixel(x, y, 0, 95, 180);
                    else {
                        const i = (y * width + x) * 4;
                        data[i] = Math.round(data[i]! * .85);
                        data[i + 1] = Math.round(data[i + 1]! * .85 + 95 * .15);
                        data[i + 2] = Math.round(data[i + 2]! * .85 + 180 * .15);
                    }
                }
            const label = String(index + 1), lx = Math.min(x0, Math.max(0, width - label.length * 12 - 4)), ly = y0 >= 24 ? y0 - 24 : y0;
            for (let y = 0; y < 24; y++)
                for (let x = 0; x < label.length * 12 + 4; x++)
                    pixel(lx + x, ly + y, 255, 255, 255);
            [...label].forEach((d, j) => [...digits[Number(d)]!].forEach((v, k) => {
                if (v === '1')
                    for (let yy = 0; yy < 3; yy++)
                        for (let xx = 0; xx < 3; xx++)
                            pixel(lx + 3 + j * 12 + k % 3 * 3 + xx, ly + 4 + Math.floor(k / 3) * 3 + yy, 0, 40, 85);
            }));
        });
    return encodePng({ width, height, data });
}
