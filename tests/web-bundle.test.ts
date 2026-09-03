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

  const script = /\.\/([^\"]+\.js)/.exec(source)?.[1];
  expect(script).toBeTruthy();
  const asset = respond(new Request(`http://127.0.0.1:1234/s/example/${script}`));
  expect(asset.status).toBe(200);
  expect(asset.headers.get("content-type")).toContain("text/javascript");
});
