import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { usePaseo, useRpc, type PluginClientContext, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { z } from "zod";
import { getState } from "./state";
import { openRpc } from "../shared/contracts";
import { parseTurnMessage, type TurnMessage } from "../shared/turn-message";

function TurnChip({ agentId, item, theme }: PluginTimelineItemProps<TurnMessage>) {
  const paseo = usePaseo(), open = useRpc(openRpc), [error, setError] = useState("");
  const data = item.data;
  const reveal = async () => {
    try {
      const connection = getState().connection;
      if (!connection) throw new Error("Tether is reconnecting.");
      const agent = paseo.agents.ref(agentId);
      const snapshot = await agent.refresh();
      const workspaceId = snapshot?.agent.workspaceId;
      if (!workspaceId) throw new Error("This agent has no active workspace.");
      await open({ generation: connection.generation, workspaceId, path: data.path, ...(data.documentId ? { documentId: data.documentId } : {}) });
      setError("");
    } catch { setError("Could not open the document. Check the Tether connection."); }
  };
  return <View style={{ gap: 6 }}>
    {!!data.annotations && <Text selectable style={{ color: theme.colors.foreground }}>{data.annotations}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={`Open Tether document: ${data.path}`} onPress={() => { void reveal(); }}
      style={{ alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border }}>
      <Text style={{ color: theme.colors.foreground }}>Tether · {data.path.split("/").pop()?.replace(/\.md$/i, "")}</Text>
    </Pressable>
    {!!error && <Text style={{ color: theme.colors.foreground }}>{error}</Text>}
  </View>;
}
export function registerTurnChip(client: PluginClientContext): () => void {
  const renderer = client.addTimelineRenderer({ kind: "turn", version: 1,
    schema: z.object({ path: z.string(), documentId: z.string().optional(), signalId: z.string().optional(), annotations: z.string() }), Component: TurnChip });
  const transformer = client.addTimelineTransformer({ id: "turn", query: { itemType: "user_message" }, transform: ({ item }) => {
    const data = parseTurnMessage(item.text);
    return data ? { items: [{ type: "plugin", kind: "turn", version: 1, data }] } : undefined;
  } });
  return () => { transformer(); renderer(); };
}
