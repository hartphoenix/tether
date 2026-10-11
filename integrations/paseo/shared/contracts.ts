import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const pathSchema = z.string().min(1).max(32768);
const idSchema = z.string().min(1).max(256);
// Missing generations are accepted by validation only to return a useful reload error.
const generationInput = { generation: z.string().max(128).optional() };
export const connectionSchema = z.object({ generation: z.string(), tetherPath: z.string(), profile: z.string() });
export type Connection = z.infer<typeof connectionSchema>;

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
  /** The document's canonical path; reader panels are keyed by it. */
  path: z.string().optional(),
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
  connection: connectionSchema.nullable(),
  revision: z.number(),
  intents: z.array(intentSchema),
  folio: z.array(folioEntrySchema).nullable(),
  notices: z.record(z.string(), noticeSchema),
  /** Whether the Tether header button is shown at all. */
  buttons: z.boolean(),
  /** Whether readers open as plugin panels instead of browser tabs. */
  readerPanels: z.boolean().optional(),
  status: statusSchema,
});
export type PumpBatch = z.infer<typeof pumpBatchSchema>;

/** Resolves when the hub changes past `revision`, or with executor work, or after at most 25 s. */
export const pumpRpc = defineRpc({
  name: "tether.pump",
  input: z.object({ revision: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER), executor: z.boolean(), generation: z.string().max(128).nullable().optional() }),
  output: pumpBatchSchema,
});

export const ackRpc = defineRpc({
  name: "tether.ack",
  input: z.object({ ...generationInput, ids: z.array(idSchema).max(256) }),
  output: z.object({ acknowledged: z.number() }),
});

/** Ask Tether to open a document for the user in a workspace; the tab arrives as an intent. */
export const openRpc = defineRpc({
  name: "tether.open",
  input: z.object({ ...generationInput, path: pathSchema, workspaceId: idSchema }),
  output: z.object({ queued: z.boolean() }),
});

export const pinRpc = defineRpc({
  name: "tether.pin",
  input: z.object({ ...generationInput, path: pathSchema, pinned: z.boolean() }),
  output: z.object({ pinned: z.boolean() }),
});

export const folioViewSchema = z.object({ url: z.string().url(), expiresAt: z.number().finite() });
export type FolioView = z.infer<typeof folioViewSchema>;

/** Expected settings bind the launch to the client's cached connection, not a new executable. */
export const folioViewRpc = defineRpc({
  name: "tether.folio-view",
  input: z.object({ ...generationInput, workspaceId: idSchema, tetherPath: z.string().max(32768), profile: idSchema }),
  output: folioViewSchema,
});

export const tetherSettings = defineSettings({
  id: "tether",
  scope: "host",
  version: 1,
  schema: z.object({
    tetherPath: z.string().trim().max(32768).default(""),
    profile: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "Use 1–64 letters, numbers, underscores or hyphens").default("preview"),
    buttons: z.boolean().default(true),
    readerPanels: z.boolean().default(false),
  }),
});
export type TetherSettings = z.infer<typeof tetherSettings.schema>;

export const themeRpc = defineRpc({
  name: "tether.theme",
  input: z.object({ ...generationInput, clientId: z.string().uuid(), theme: z.string().max(128).nullable(), tetherPath: z.string().max(32768), profile: idSchema }),
  output: z.object({ updated: z.boolean() }),
});
