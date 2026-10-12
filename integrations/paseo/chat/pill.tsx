// Composer pill and panel presentation adapted from Annotations (NOTICE.md).
import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import type { CollectionHost } from "./collections";

function NoIcon() {
  return <View ref={node => {
    const element = node as unknown as HTMLElement | null;
    if (element?.parentElement) element.parentElement.style.display = "none";
  }} />;
}

/** Use the same host-owned track and popover as the original Annotations pill. */
export function createComposerCollections(client: PluginClientContext): CollectionHost {
  const workspaces = new Map<string, string>();
  const entries = new Map<string, { panel: HTMLElement; label: string; visible: boolean; registration?: PluginButtonRegistration; workspace?: string }>();
  const lifetime = new AbortController();
  let release: (() => void) | undefined;
  const register = (key: string) => {
    const entry = entries.get(key)!;
    const [host, agent] = JSON.parse(key) as [string, string];
    const workspace = workspaces.get(agent);
    if (!workspace) { entry.registration?.remove(); entry.registration = undefined; return; }
    if (entry.registration && entry.workspace === workspace) {
      entry.registration.update({ label: entry.label, visible: entry.visible }); return;
    }
    entry.registration?.remove(); entry.workspace = workspace;
    const Content = (props: PluginButtonContentProps) => {
      const ref = useRef<View>(null);
      useEffect(() => {
        const mount = ref.current as unknown as HTMLElement | null;
        if (props.host.id !== host || props.context !== "agent" || props.agentId !== agent || !mount?.append) return;
        mount.append(entry.panel);
        const close = () => props.close();
        entry.panel.addEventListener("tether-edit-annotation", close);
        return () => { entry.panel.removeEventListener("tether-edit-annotation", close); entry.panel.remove(); };
      }, []);
      return <View ref={ref} />;
    };
    entry.registration = client.addComposerPill({ id: "tether-annotations", workspaceId: workspace, agentId: agent,
      button: { title: "Annotations", icon: NoIcon, label: entry.label, visible: entry.visible, behavior: { kind: "popover", Content } } });
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) { void subscription.release(); return; }
    release = () => { void subscription.release(); };
    subscription.subscribe({
      snapshot: ({ entries: agents }) => {
        workspaces.clear();
        for (const { agent } of agents) if (agent.workspaceId) workspaces.set(agent.id, agent.workspaceId);
        for (const key of entries.keys()) register(key);
      },
      update: message => {
        if (lifetime.signal.aborted || message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") { if (update.agent.workspaceId) workspaces.set(update.agent.id, update.agent.workspaceId); else workspaces.delete(update.agent.id); }
        else workspaces.delete(update.agentId);
        for (const key of entries.keys()) register(key);
      },
    });
  }).catch(() => {});
  return {
    update(key, _input, panel, label, visible) {
      const entry = entries.get(key);
      if (entry) { if (entry.label === label && entry.visible === visible) return; entry.label = label; entry.visible = visible; }
      else entries.set(key, { panel, label, visible });
      register(key);
    },
    remove(key) { entries.get(key)?.registration?.remove(); entries.delete(key); },
    dispose() { lifetime.abort(); release?.(); for (const key of entries.keys()) this.remove(key); },
  };
}
