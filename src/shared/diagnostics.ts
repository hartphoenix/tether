/** Bounded diagnostics, never a dump of an Error, environment, or request. */
export function diagnosticText(value: string): string {
  const safe = value
    .replace(/(["\']?[\w-]*(?:token|secret|password|api[_-]?key|jwt|ticket|authorization|cookie)["\']?\s*[:=]\s*)(?:"[^"\r\n]*"|\'[^\'\r\n]*\'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(/([?&](?:ticket|token|key|credential|authorization)=)[^\s&#"']+/gi, "$1[redacted]")
    .replace(/\b((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*)[^\s,;]+/g, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
  return safe.length > 2048 ? `${safe.slice(0, 2048)}…[truncated]` : safe;
}

/** Drain a subprocess diagnostic stream while retaining only a bounded prefix. */
export async function diagnosticOutput(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let retained = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const portion = value.subarray(0, Math.max(0, 8192 - retained));
      if (portion.length) { chunks.push(portion); retained += portion.length; }
      if (portion.length < value.length) truncated = true;
    }
  } finally { reader.releaseLock(); }
  return diagnosticText(Buffer.concat(chunks).toString("utf8")) + (truncated ? " [truncated]" : "");
}

export function diagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return diagnosticText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (depth >= 5) return "[truncated]";
  if (Array.isArray(value)) return [...value.slice(0, 20).map(item => diagnosticValue(item, depth + 1)), ...(value.length > 20 ? ["[truncated]"] : [])];
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return Object.fromEntries([...entries.slice(0, 32).map(([key, item]) => [key, /token|secret|password|authorization|cookie|ticket|jwt|api[_-]?key/i.test(key) ? "[redacted]" : diagnosticValue(item, depth + 1)]), ...(entries.length > 32 ? [["truncated", true]] : [])]);
  }
  return undefined;
}

export function diagnostic(cause: unknown, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = { message: diagnosticText(cause instanceof Error ? cause.message : String(cause)) };
  if (!cause || typeof cause !== "object") return result;
  const value = cause as Record<string, unknown>;
  for (const key of ["code", "syscall", "path", "dest", "status", "exitCode", "causeText"]) {
    if (typeof value[key] === "string" || typeof value[key] === "number") result[key] = diagnosticValue(value[key]);
  }
  if (value.cause !== undefined) result.cause = depth < 2 ? diagnostic(value.cause, depth + 1) : "[truncated]";
  return result;
}

export function errorDetails(cause: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const details = cause && typeof cause === "object" ? (cause as { details?: unknown }).details : undefined;
  const preserved = details && typeof details === "object" ? diagnosticValue(details) as Record<string, unknown> : {};
  const status = cause && typeof cause === "object" ? (cause as { status?: unknown }).status : undefined;
  return { diagnostic: diagnostic(cause), ...preserved, ...(typeof status === "number" ? { httpStatus: status } : {}), ...extra };
}

export function operationError(cause: unknown, details: Record<string, unknown>): Error & { code: string; details: Record<string, unknown> } {
  const code = cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string" ? (cause as { code: string }).code : "command_failed";
  return Object.assign(new Error(diagnosticText(cause instanceof Error ? cause.message : String(cause)), { cause }), { code, details: errorDetails(cause, details) });
}
