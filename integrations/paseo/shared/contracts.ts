import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** The subset of a Tether Folio entry the plugin renders. */
export const folioEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  directory: z.string(),
  repository: z.string().nullable(),
  pinned: z.boolean(),
  missing: z.boolean(),
  attentionCount: z.number(),
  openedAt: z.number(),
});
export type FolioEntry = z.infer<typeof folioEntrySchema>;

/** A reader tab for a client that can open tabs, resolved to its Paseo workspace. */
export const intentSchema = z.object({
  id: z.string(),
  url: z.string(),
  workspaceId: z.string(),
});
export type Intent = z.infer<typeof intentSchema>;

/** A document announced to one workspace's header button. */
export const noticeSchema = z.object({ path: z.string(), name: z.string() });
export type Notice = z.infer<typeof noticeSchema>;

export const statusSchema = z.object({
  connected: z.boolean(),
  tether: z.string().nullable(),
  error: z.string().nullable(),
});
export type HubStatus = z.infer<typeof statusSchema>;

export const pumpBatchSchema = z.object({
  revision: z.number(),
  intents: z.array(intentSchema),
  folio: z.array(folioEntrySchema).nullable(),
  notices: z.record(z.string(), noticeSchema),
  /** Whether the Tether header button is shown at all. */
  buttons: z.boolean(),
  status: statusSchema,
});
export type PumpBatch = z.infer<typeof pumpBatchSchema>;

/** Resolves when the hub changes past `revision`, or with executor work, or after at most 25 s. */
export const pumpRpc = defineRpc({
  name: "tether.pump",
  input: z.object({ revision: z.number(), executor: z.boolean() }),
  output: pumpBatchSchema,
});

export const ackRpc = defineRpc({
  name: "tether.ack",
  input: z.object({ ids: z.array(z.string()) }),
  output: z.object({ acknowledged: z.number() }),
});

/** Ask Tether to open a document for the user in a workspace; the tab arrives as an intent. */
export const openRpc = defineRpc({
  name: "tether.open",
  input: z.object({ path: z.string(), workspaceId: z.string() }),
  output: z.object({ queued: z.boolean() }),
});

export const pinRpc = defineRpc({
  name: "tether.pin",
  input: z.object({ path: z.string(), pinned: z.boolean() }),
  output: z.object({ pinned: z.boolean() }),
});

export const tetherSettings = defineSettings({
  id: "tether",
  scope: "host",
  version: 1,
  schema: z.object({
    tetherPath: z.string().trim().default(""),
    profile: z.string().trim().min(1, "Enter a profile").default("preview"),
    buttons: z.boolean().default(true),
  }),
});
export type TetherSettings = z.infer<typeof tetherSettings.schema>;
