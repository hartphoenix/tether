import { expect, test } from "bun:test";
import { createWebBundleResponder } from "../src/web/bundle";

test("builds and serves the extracted editor with relative session assets", async () => {
  const respond = await createWebBundleResponder();
  const html = respond(new Request("http://127.0.0.1:1234/s/example/"));
  expect(html.status).toBe(200);
  expect(html.headers.get("content-type")).toContain("text/html");
  const source = await html.text();
  expect(source).toContain("Tether");
  expect(source).toMatch(/\.\/[^\"]+\.js/);
  expect(source).toMatch(/\.\/[^\"]+\.css/);
  expect(source).not.toContain("token=");
  const icon = /<link[^>]*rel="icon"[^>]*href="([^\"]+)"/.exec(source)![1];
  expect(icon).toBe("/favicon.png");

  const script = /\.\/([^\"]+\.js)/.exec(source)?.[1];
  expect(script).toBeTruthy();
  const asset = respond(new Request(`http://127.0.0.1:1234/s/example/${script}`));
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/javascript");
});

test('bundled fonts are embedded in the local stylesheet with no Google requests', async () => {
  const respond = await createWebBundleResponder();
  const html = await respond(new Request('http://127.0.0.1:1234/s/example/')).text();
  const cssName = /\.\/([^\"]+\.css)/.exec(html)![1];
  const css = await respond(new Request(`http://127.0.0.1:1234/s/example/${cssName}`)).text();
  expect(css).not.toContain('fonts.googleapis.com'); expect(css).not.toContain('fonts.gstatic.com');
  const families = [...css.matchAll(/font-family:([^;{}]+)/g)].map(match => match[1].replaceAll('"', '').replaceAll("'", ''));
  for (const family of ['Hanken Grotesk', 'Source Serif 4', 'Source Sans 3', 'Cabin', 'Alegreya', 'DM Mono']) {
    expect(families).toContain(family);
  }
  const data = /src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)/.exec(css)![1];
  expect(Buffer.from(data, 'base64').subarray(0, 4).toString()).toBe('wOF2');
});
