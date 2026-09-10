export const INPUT_LIMITS = { review: 256 * 1024, markdown: 16 * 1024 * 1024, package: 32 * 1024 * 1024, quote: 64 * 1024, identifier: 8 * 1024 } as const;
export function invalidRequest(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_request", status: 400 });
}
export function validateControlInput(body: Record<string, unknown>, path: string): void {
  for (const key of ["expectedBodyRevision", "fromRevision", "expectedLedgerRevision", "expectedConversationRevision"] as const) {
    if (body[key] !== undefined && (typeof body[key] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(body[key] as string))) throw invalidRequest(`Invalid ${key}: expected sha256:<64 lowercase hex characters>.`);
  }
  for (const key of ["actor", "consumer", "operationId", "threadId", "targetId", "eventId", "path", "target", "cursor", "continuation", "candidateId", "expectedBodyRevision", "fromRevision"] as const) {
    if (key === "target" && body.target && typeof body.target === "object" && !Array.isArray(body.target) && !["/control/document/move", "/control/folio/locate"].includes(path) && !path.endsWith("/open")) {
      if (Object.entries(body.target).some(([key, value]) => key.length > 128 || typeof value !== "string" || Buffer.byteLength(value) > INPUT_LIMITS.identifier)) throw invalidRequest("Invalid host target.");
      continue;
    }
    if (body[key] !== undefined && (typeof body[key] !== "string" || !(body[key] as string).trim() || Buffer.byteLength(body[key] as string) > INPUT_LIMITS.identifier)) throw invalidRequest(`Invalid ${key}.`);
  }
  for (const key of ["limit", "maxBytes", "beforeSequence", "expectedThreadSequence", "offset", "radius"] as const) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || Number(body[key]) < (key === "offset" ? 0 : 1))) throw invalidRequest(`Invalid ${key}.`);
  }
  for (const key of ["body", "text", "quote"] as const) {
    const limit = key === "quote" ? INPUT_LIMITS.quote : path.includes("review/") || path.includes("annotations") ? INPUT_LIMITS.review : INPUT_LIMITS.markdown;
    if (body[key] !== undefined && (typeof body[key] !== "string" || Buffer.byteLength(body[key] as string) > limit)) throw invalidRequest(`${key} exceeds its byte limit or is not text.`);
  }
  if (body.status !== undefined && !["open", "resolved"].includes(body.status as string)) throw invalidRequest("Invalid thread status.");
}
