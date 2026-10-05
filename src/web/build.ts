import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/** One build path for source daemons, checks, and installed packages. */
export async function buildWeb(outdir?: string): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const root = dirname(fileURLToPath(import.meta.url));
  const fonts = new Map<string, Uint8Array<ArrayBuffer>>();
  const result = await Bun.build({
    entrypoints: [join(root, 'app.ts'), join(root, 'index.html')],
    minify: true, splitting: true, naming: '[name]-[hash].[ext]', target: 'browser',
    external: ['*.woff2', '*.woff', '*.ttf'],
    plugins: [{ name: 'external-fonts', setup(build) {
      build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
        const css = await readFile(path, 'utf8');
        const urls = [...css.matchAll(/url\(\s*(['"]?)([^)'"\s]+\.(?:woff2?|ttf))\1\s*\)/g)];
        let contents = css;
        for (const [original, , url] of urls) {
          const bytes = await readFile(resolve(dirname(path), url));
          const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex').slice(0, 20);
          const name = `${basename(url, extname(url))}-${hash}${extname(url)}`;
          fonts.set(name, new Uint8Array(bytes));
          contents = contents.replace(original, `url(/assets/${name})`);
        }
        return { contents, loader: 'css' };
      });
    } }],
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  const assets = new Map<string, Uint8Array<ArrayBuffer>>(fonts);
  for (const output of result.outputs) assets.set(basename(output.path), new Uint8Array(await output.arrayBuffer()));
  const htmlName = [...assets.keys()].find(name => name.endsWith('.html'))!;
  const html = await new HTMLRewriter()
    .on('script[src],link[href]', { element(node) {
      const attribute = node.tagName === 'script' ? 'src' : 'href';
      const value = node.getAttribute(attribute);
      if (value?.startsWith('./')) node.setAttribute(attribute, `/assets/${value.slice(2)}`);
    } })
    .transform(new Response(assets.get(htmlName)!)).text();
  assets.delete(htmlName);
  assets.set('index.html', new TextEncoder().encode(html));
  if (outdir) {
    await mkdir(outdir, { recursive: true });
    await Promise.all([...assets].map(([name, bytes]) => writeFile(join(outdir, name), bytes)));
  }
  return assets;
}
