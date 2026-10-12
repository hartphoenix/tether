import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
// Exercise native registration with the SDK host boundary mocked, without a desktop.
const build = await Bun.build({ entrypoints: ['integrations/paseo/chat/pill.tsx'], target: 'bun', plugins: [{ name: 'native-view', setup(build) {
  build.onResolve({ filter: /^react-native$/ }, () => ({ path: 'view', namespace: 'native-view' }));
  build.onLoad({ filter: /.*/, namespace: 'native-view' }, () => ({ contents: 'export const View = () => null;', loader: 'js' }));
} }] });
if (!build.success) throw new Error(build.logs.join('\n'));
const directory = await mkdtemp(join(tmpdir(), "tether-pill-check-"));
const bundle = join(directory, "pill.mjs"); await Bun.write(bundle, await build.outputs[0].text());
const { createComposerCollections } = await import(bundle);
await rm(directory, { recursive: true });
let observer: any, released = false, signal: AbortSignal;
const registrations: any[] = [];
const client = {
  paseo: { agents: { async list(options: any) { signal = options.signal; return { subscription: { subscribe(value: any) { observer = value; }, release() { released = true; } } }; } } },
  addComposerPill(options: any) {
    const entry = { ...options, removed: false }; registrations.push(entry);
    return { update(patch: any) { Object.assign(entry.button, patch); }, remove() { entry.removed = true; } };
  },
};
const host = createComposerCollections(client), key = JSON.stringify(['server', 'agent']);
host.update(key, {}, {}, '2 annotations', true);
await Promise.resolve();
observer.snapshot({ entries: [{ agent: { id: 'agent', workspaceId: 'workspace-a' } }] });
assert.equal(registrations.length, 1);
assert.equal(registrations[0].agentId, 'agent');
assert.equal(registrations[0].workspaceId, 'workspace-a');
assert.equal(registrations[0].button.behavior.kind, 'popover');
host.update(key, {}, {}, '1 annotation', true);
assert.equal(registrations[0].button.label, '1 annotation');
observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { id: 'agent', workspaceId: 'workspace-b' } } });
assert.equal(registrations[0].removed, true);
assert.equal(registrations[1].workspaceId, 'workspace-b');
host.update(key, {}, {}, '0 annotations', false);
assert.equal(registrations[1].button.visible, false);
observer.snapshot({ entries: [] });
assert.equal(registrations[1].removed, true);
host.dispose();
assert.equal(released, true); assert.equal(signal!.aborted, true);
console.log('Composer pill checks passed: scoped registration, counts, workspace moves, visibility, removal and disposal.');
