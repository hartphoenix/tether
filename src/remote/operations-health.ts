/** Operational metadata only; never exposes document or credential state. */
export function operationsHealth(request: Request, surface: "reader" | "approval", revision: string): Response | undefined {
  const url = new URL(request.url);
  const port = surface === "reader" ? 8413 : 8414;
  if (request.method !== "GET" || url.pathname !== "/health" || url.host !== `127.0.0.1:${port}`) return;
  return Response.json({ service: "tether-phone-reader", surface, revision }, { headers: { "Cache-Control": "no-store" } });
}
