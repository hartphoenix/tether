// Invoked by the prototype server over stdin/stdout; only this process opens SQLite.
import { PrivateStore } from "../src/storage/private-store";
import { PrototypeStore } from "../src/chat/prototype-store";
import { probeRpc } from "../integrations/paseo/prototype/contracts";

const input = probeRpc.input.parse(JSON.parse(await Bun.stdin.text()));
const path = process.argv[2];
if (!path || !path.endsWith("/delivery-prototype.sqlite")) throw new Error("An isolated prototype database is required.");
const owner = new PrivateStore(path);
owner.db.exec("PRAGMA synchronous=FULL");
try {
  const store = new PrototypeStore(owner.db);
  const scope = JSON.stringify([input.host, input.agent]);
  const op = input.operation;
  const result = op.kind === "read" ? store.read(scope)
    : op.kind === "save" ? store.save(scope, op.draft)
    : op.kind === "capture" ? store.capture(scope, op.id, op.prose, op.attachments)
    : op.kind === "dispatch" ? store.dispatch(scope, op.id, op.messageId, op.text, op.options)
    : op.kind === "accepted" ? store.accepted(scope, op.id, op.messageId)
    : store.cancelPrepared(scope, op.id);
  process.stdout.write(JSON.stringify({ ok: true, data: result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Prototype storage failed." }));
  process.exitCode = 1;
} finally { owner.close(); }
