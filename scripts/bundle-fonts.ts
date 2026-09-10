// Refresh the locally served Google Fonts assets and their redistribution licenses.
import { mkdir } from 'node:fs/promises';
const families = [
  ['Hanken Grotesk', 'hankengrotesk', '100..900'],
  ['Source Serif 4', 'sourceserif4', '200..900'],
  ['Source Sans 3', 'sourcesans3', '200..900'],
  ['Cabin', 'cabin', '400..700'],
  ['Alegreya', 'alegreya', '400..900'],
  ['DM Mono', 'dmmono', '300;400;500'],
];
const dir = new URL('../src/web/fonts/', import.meta.url);
await mkdir(dir, { recursive: true });
const agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
async function get(url: string) {
  const r = await fetch(url, { headers: { 'User-Agent': agent } });
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  return r;
}
let css = '/* Locally bundled Google Fonts. See fonts/*-OFL.txt for licenses. */\n';
for (const [name, slug, weights] of families) {
  const tuples = [0, 1].flatMap(italic => weights.split(';').map(w => `${italic},${w}`)).join(';');
  const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:ital,wght@${tuples}&display=swap`;
  let sheet = await (await get(url)).text();
  const urls = [...new Set([...sheet.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
  for (const [i, remote] of urls.entries()) {
    const ext = new URL(remote).pathname.endsWith('.woff2') ? 'woff2' : 'ttf';
    const file = `${slug}-${i}.${ext}`;
    await Bun.write(new URL(file, dir), await (await get(remote)).arrayBuffer());
    sheet = sheet.replaceAll(remote, `./fonts/${file}`);
  }
  await Bun.write(new URL(`${slug}-OFL.txt`, dir), await (await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${slug}/OFL.txt`)).text());
  css += `\n/* ${name} */\n${sheet}`;
  console.log(`${name}: ${urls.length} files`);
}
await Bun.write(new URL('../src/web/fonts.css', import.meta.url), css);
