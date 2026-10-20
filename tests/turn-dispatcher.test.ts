import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { HostTurns } from "../src/server/host-turns";
import { TurnDispatcher, findTurnInput } from "../integrations/paseo/server/turn-dispatcher";
import type { TurnAgentHandle, TimelinePage } from "../integrations/paseo/server/turn-sdk";
import type { TurnTransport } from "../integrations/paseo/server/turn-transport";

function fixture(behavior: "queue" | "steer" | "interrupt" = "steer") {
  const db = new Database(":memory:"), service = new HostTurns(db), lifetime = new AbortController();
  const entries: TimelinePage["entries"] = [];
  let status = "idle", permissions: unknown[] = [], lost = false, log = true;
  const sends: { text: string; options: any }[] = [], watchers = new Set<() => void>();
  const handle: TurnAgentHandle = {
    refresh: async () => ({ agent: { status, pendingPermissions: permissions } }),
    subscribe: fn => { watchers.add(fn); return () => { watchers.delete(fn); }; },
    send: async (text, options) => {
      sends.push({ text, options }); status = "running";
      if (log) entries.push({ seq: entries.length + 1, item: { type: "user_message", text, clientMessageId: options.messageId } });
      if (lost) throw new Error("Response lost");
    },
    timeline: { refetch: async options => {
      const selected = options?.direction === "after" ? entries.filter(e => e.seq > options.cursor!.seq).slice(0, options.limit) : entries.slice(-(options?.limit ?? 1));
      const last = selected.at(-1)?.seq ?? 0;
      return { entries: selected, epoch: "session-one", endCursor: { epoch: "session-one", seq: last },
        startCursor: { epoch: "session-one", seq: selected[0]?.seq ?? 0 }, hasOlder: false, hasNewer: entries.some(e => e.seq > last) };
    } },
  };
  service.register({ documentId: "doc", path: "/document.md", machineId: "file-machine", hostId: "host", owner: "owner", agentId: "paseo:agent", behavior });
  const lease = service.lease("owner", "host", "instance");
  const transport: TurnTransport = {
    command: async input => {
      if (input.action === "verify") return service.verify("owner", "host", lease.token, input.signalId as string);
      if (input.action === "availability") return service.availability("owner", "host", lease.token, input.agentId as string, input.reason as string | undefined);
      return service.update("owner", "host", lease.token, input.signalId as string, input.action as any, input);
    }, events: async () => {},
  };
  const dispatcher = new TurnDispatcher({ hostId: "host", home: "/nonexistent-tether-test", agent: () => handle, disconnected: () => () => {}, close: async () => {} },
    transport, () => lease.token, lifetime.signal, [1, 1]);
  const off = service.subscribe(() => dispatcher.update(service.snapshot("owner", "host")));
  dispatcher.update(service.snapshot("owner", "host"));
  const settle = async () => { for (let i = 0; i < 10; i++) { await dispatcher.settled(); await Promise.resolve(); } };
  return { service, handle, sends, entries, dispatcher, settle, transport,
    set: (value: { status?: string; permissions?: unknown[]; lost?: boolean; log?: boolean }) => {
      if (value.status) status = value.status; if (value.permissions) permissions = value.permissions;
      if (value.lost !== undefined) lost = value.lost; if (value.log !== undefined) log = value.log;
      for (const wake of watchers) wake();
    },
    press: (operation = "op") => service.request("doc", "paseo:agent", operation),
    close: () => { lifetime.abort(); dispatcher.stop(); off(); db.close(); },
  };
}

test("event replay, stale lifecycle notifications and idle reconnects cause no duplicate sends", async () => {
  const f = fixture();
  try {
    await f.settle(); expect(f.sends).toHaveLength(0);
    const signal = f.press(); await f.settle();
    expect(f.sends).toHaveLength(1); expect(f.service.signal(signal.signalId)?.state).toBe("accepted");
    f.dispatcher.update(f.service.snapshot("owner", "host")); f.dispatcher.wake("paseo:agent"); await f.settle();
    expect(f.sends).toHaveLength(1); expect(f.service.signal(signal.signalId)?.state).toBe("accepted");
    f.set({ status: "idle" }); await f.settle();
    expect(f.service.signal(signal.signalId)?.state).toBe("completed");
    f.press("next"); await f.settle(); f.dispatcher.wake("paseo:agent"); await f.settle();
    expect(f.sends).toHaveLength(2); expect(f.service.agents("doc")[0]!.state).toBe("working");
  } finally { f.close(); }
});
test("busy agents preserve steer, interrupt and queue; permissions stay visible", async () => {
  for (const behavior of ["steer", "interrupt", "queue"] as const) {
    const f = fixture(behavior);
    try {
      f.set({ status: "running" }); f.press(); await f.settle();
      expect(f.sends).toHaveLength(behavior === "queue" ? 0 : 1);
      if (behavior === "queue") { f.set({ status: "idle" }); await f.settle(); }
      expect(f.sends[0]!.options.activeTurnBehavior).toBe(behavior === "queue" ? "steer" : behavior);
      f.set({ permissions: [{}] }); await f.settle();
      expect(f.service.agents("doc")[0]!.reason).toContain("permission");
      f.set({ status: "idle", permissions: [] }); await f.settle();
      expect(f.service.agents("doc")[0]!.state).toBe("ready");
    } finally { f.close(); }
  }
});
test("lost send response recovers from the input log; absence alone never resends", async () => {
  const f = fixture();
  try {
    f.set({ lost: true }); const first = f.press(); await f.settle();
    expect(f.service.signal(first.signalId)?.state).toBe("accepted"); expect(f.sends).toHaveLength(1);
    f.set({ status: "idle" }); await f.settle();
    f.set({ log: false }); const second = f.press("second"); await f.settle();
    expect(f.service.signal(second.signalId)?.state).toBe("uncertain");
    f.dispatcher.update(f.service.snapshot("owner", "host")); await f.settle();
    expect(f.sends).toHaveLength(2);
    f.entries.push({ seq: f.entries.length + 1, item: { type: "user_message", text: second.text, clientMessageId: second.signalId } });
    f.entries.push({ seq: f.entries.length + 1, item: { type: "user_message", text: "A later input" } });
    f.set({ status: "idle" }); await f.settle();
    expect(f.service.signal(second.signalId)?.state).toBe("completed"); expect(f.sends).toHaveLength(2);
  } finally { f.close(); }
});
test("recipient search crosses later inputs within its bounded pre-send range", async () => {
  const f = fixture();
  try {
    const signal = f.press(); signal.position = { epoch: "session-one", seq: 0 };
    f.entries.push({ seq: 1, item: { type: "user_message", clientMessageId: signal.signalId } });
    for (let i = 2; i < 300; i++) f.entries.push({ seq: i, item: { type: "assistant_message", text: "later" } });
    expect(await findTurnInput(f.handle, signal)).toBe(true);
    signal.position = { epoch: "different-session", seq: 0 };
    expect(await findTurnInput(f.handle, signal)).toBe(false);
    await f.settle();
  } finally { f.close(); }
});
test("queued invitations on another document proceed after the first completes", async () => {
  const f = fixture("queue");
  try {
    f.service.register({ documentId: "other-doc", path: "/other.md", machineId: "file-machine", hostId: "host", owner: "owner", agentId: "paseo:agent", behavior: "queue" });
    f.press();
    f.service.request("other-doc", "paseo:agent", "other");
    await f.settle(); expect(f.sends).toHaveLength(1);
    f.set({ status: "idle" }); await f.settle();
    expect(f.sends).toHaveLength(2); expect(f.sends[1]!.text).toContain('path="/other.md"');
  } finally { f.close(); }
});

test("a registration removed after claim cannot cross the host send boundary", async () => {
  const f = fixture();
  try {
    const command = f.transport.command;
    f.transport.command = async input => {
      const value = await command(input);
      if (input.action === "claim") f.service.unregister("doc", "paseo:agent");
      return value;
    };
    f.press(); await f.settle();
    expect(f.sends).toHaveLength(0);
    expect(f.service.agents("doc")).toEqual([]);
  } finally { f.close(); }
});
