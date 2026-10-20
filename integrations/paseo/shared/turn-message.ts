export type TurnMessage = { path: string; documentId?: string; signalId?: string; annotations: string };

/** Only the terminal invitation marker is presentation; preceding feedback remains intact. */
export function parseTurnMessage(text: string): TurnMessage | undefined {
  const marker = /(?:^|\n\n)<tether-turn path="([^"]+)"(?: document-id="([a-zA-Z0-9-]+)")?(?: signal-id="([a-zA-Z0-9-]+)")? \/>$/.exec(text);
  if (!marker) return;
  const path = marker[1]!.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return { path, ...(marker[2] ? { documentId: marker[2] } : {}), ...(marker[3] ? { signalId: marker[3] } : {}), annotations: text.slice(0, marker.index) };
}
