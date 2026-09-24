import type { TetherConfig } from "./config";
import { stopCmuxBridge } from "../hosts/cmux-bridge";
import { stopWaveBridge } from "../hosts/wave-bridge";

export async function stopHostBridges(config: TetherConfig): Promise<void> {
  const results = await Promise.allSettled([stopCmuxBridge(config), stopWaveBridge(config)]);
  if (results.some(result => result.status === "rejected")) throw new Error("Tether stopped accepting automatic starts, but a host helper did not confirm shutdown.");
}
