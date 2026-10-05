import { useSettings } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { tetherSettings } from "../shared/contracts";

export function useTetherSettings() {
  const client = useQueryClient();
  // Paseo's settings RPC is local; browser offline events must not pause it.
  // Configure before useSettings creates its query, including on a cold mount.
  const key = ["plugin-settings", tetherSettings.id];
  client.setQueryDefaults(key, { ...client.getQueryDefaults(key), networkMode: "always" });
  return useSettings(tetherSettings);
}
