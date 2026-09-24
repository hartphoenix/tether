/** Smoke-check helper: call only after the packaged CLI accepts daemon stop. */
export async function waitForDaemonStop(command: string[], options: {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = performance.now() + (options.timeoutMs ?? 4000);
  let lastStatus = "No status received.";
  while (performance.now() < deadline) {
    const child = Bun.spawn([...command, "daemon", "status"], {
      env: options.env, cwd: options.cwd, stdout: "pipe", stderr: "pipe",
      timeout: Math.max(1, Math.ceil(deadline - performance.now())), killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    lastStatus = `${err} ${out}`.trim();
    if (performance.now() >= deadline) break;
    const result = JSON.parse(out);
    if (code === 0 && result.ok === true && result.data?.running === false) return;
    const running = code === 0 && result.ok === true && result.data?.running === true;
    // Shutdown answers health with 503 (service_stopping), then closes the
    // listener before removing discovery. Both are retryable, but never prove
    // that shutdown completed.
    const details = result.error?.details;
    const closing = code === 1 && result.ok === false
      && result.error?.code === "daemon_unreachable"
      && (details?.diagnostic?.code === "ConnectionRefused" || details?.stage === "health" && details?.httpStatus === 503);
    if (!running && !closing) throw new Error(`Daemon status failed: ${lastStatus}`);
    await Bun.sleep(Math.min(100, Math.max(0, deadline - performance.now())));
  }
  throw new Error(`Timed out waiting for daemon shutdown. Last status: ${lastStatus}`);
}
