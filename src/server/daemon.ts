import { startDaemon } from "./server";

if (import.meta.main) {
  const daemon = await startDaemon();
  await daemon.closed;
}
