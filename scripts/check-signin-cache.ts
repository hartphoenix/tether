/** Disposable two-hostname cache trial. Does not enable warming in the gateway. */
import { chromium, webkit } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createWebBundleResponder, isApplicationAsset } from '../src/web/bundle';

const root = await mkdtemp('/tmp/tether-cache-trial-');
const app = await createWebBundleResponder();
const index = await app(new Request('http://localhost/s/trial/')).text();
// This manifest contains application bytes only. Follow static imports without executing them.
const core = new Set([...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(match => match[1]));
for (const path of core) {
  if (!path.endsWith('.js')) continue;
  const source = await app(new Request(`http://localhost${path}`)).text();
  for (const match of source.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) core.add(`/assets/${match[1]}`);
}
const certificate = Bun.spawn(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=tether.test'], { stdout: 'ignore', stderr: 'ignore' });
if (await certificate.exited) throw new Error('Certificate setup failed');
let reader = '', approval = '';
const received: string[] = [];
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(join(root, 'key.pem')), cert: Bun.file(join(root, 'cert.pem')) }, fetch(request) {
  const url = new URL(request.url);
  if (url.origin === reader && isApplicationAsset(url.pathname)) {
    received.push(url.pathname);
    const response = app(request);
    response.headers.set('access-control-allow-origin', approval);
    return response;
  }
  if (url.pathname !== '/') return new Response(null, { status: 403 });
  return new Response('<!doctype html><title>Cache trial</title><p>Static asset trial</p>', { headers: {
    'content-type': 'text/html', 'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; connect-src 'self' ${reader}; script-src 'self'`,
    ...(url.origin === reader ? { 'set-cookie': '__Host-trial=authorized; Secure; HttpOnly; SameSite=Strict; Path=/' } : {}),
  } });
} });
reader = `https://reader.tether.test:${server.port}`; approval = `https://approve.tether.test:${server.port}`;
const proxy = createServer();
proxy.on('connect', (_request, client, head) => {
  const upstream = connect(server.port!, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
  client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
try {
  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]] as const) {
    const browser = await engine.launch(name === 'chromium' ? { args: ['--host-resolver-rules=MAP *.tether.test 127.0.0.1', '--no-proxy-server'] } : { proxy: { server: `http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}` } });
    try {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      await page.goto(approval);
      received.length = 0;
      await page.evaluate(async ({ reader, paths }) => { await Promise.all(paths.map(path => fetch(reader + path, { mode: 'cors', credentials: 'same-origin' }).then(response => response.arrayBuffer()))); }, { reader, paths: [...core] });
      const warmingRequests = received.length;
      await page.goto(reader);
      received.length = 0;
      await page.evaluate(async paths => { await Promise.all(paths.map(path => fetch(path, { mode: 'cors', credentials: 'same-origin' }).then(response => response.arrayBuffer()))); }, [...core]);
      console.log(JSON.stringify({ engine: name, assets: core.size, warmingRequests, repeatedRequests: received.length, reused: received.length === 0, limitation: 'Disposable hostnames and fetch requests; no real passkey timing, Safari phone, or production-origin claim.' }));
    } finally { await browser.close(); }
  }
} finally { proxy.close(); await server.stop(true); await rm(root, { recursive: true, force: true }); }
