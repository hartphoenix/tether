import { expect, test } from "bun:test";
import { createReconnectLoop } from "../src/web/reconnect";

test("retries failed initialization without concurrent runs and stops on authorization failure", async () => {
  let count = 0, active = 0, maximum = 0;
  const errors: unknown[] = [];
  const loop = createReconnectLoop({ intervalMs: 20, retryMs: 1, run: async () => {
    maximum = Math.max(maximum, ++active);
    await Bun.sleep(5); active--; count++;
    if (count === 1) throw new Error("offline");
    if (count === 3) throw Object.assign(new Error("revoked"), { status: 401 });
  }, onError: e => errors.push(e) });
  try {
    loop.wake(); loop.wake(); loop.wake();
    await Bun.sleep(90);
    expect(count).toBe(3); expect(maximum).toBe(1); expect(errors).toHaveLength(2);
  } finally { loop.dispose(); }
});

test("pause keeps UI lifecycle reusable; disposal prevents wake and in-flight rescheduling", async () => {
  let count = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const loop = createReconnectLoop({ intervalMs: 5, run: async () => { count++; await pending; }, onError: () => {} });
  loop.wake(); loop.pause(); release(); await Bun.sleep(15);
  expect(count).toBe(1);
  loop.wake(); await Bun.sleep(1); expect(count).toBe(2);
  loop.dispose(); loop.wake(); await Bun.sleep(15); expect(count).toBe(2);
});
