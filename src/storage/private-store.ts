import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  appendAnnotationEvent,
  createAnnotationLedger,
  deriveAnnotationState,
  ledgerRevision,
  type AnnotationEvent,
  type AnnotationLedger,
} from "../core/index";

export type PrivateDocumentRow = {
  id: string;
  path: string;
  title: string | null;
  added_at: number;
  opened_at: number;
  conversation_at: number | null;
  body_mtime_ms: number | null;
  created_at_ms: number | null;
  active: number;
  pinned: number;
  archived_at: number | null;
  expires_at: number | null;
};

export type MutationReceipt = {
  operationId: string;
  appliedEventId: string | null;
  appliedSequence: number;
  /** Short aliases retained for direct repository consumers. */
  eventId: string | null;
  sequence: number;
  replayed: boolean;
};

export type ReviewObservation = {
  cursor: string;
  documentId: string;
  consumer: string;
  throughSequence: number;
  bodyRevision: string;
  observationOrder: number;
};

export const REVIEW_CURSOR_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export class PrivateStoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateStoreConflictError";
  }
}

export class PrivateStoreDocumentNotFoundError extends Error {
  constructor() {
    super("The private document record no longer exists.");
    this.name = "PrivateStoreDocumentNotFoundError";
  }
}

type EventRow = { payload_json: string };
type MutationRow = { payload_hash: string; result_json: string };

export class PrivateStore {
  readonly db: Database;
  readonly path: string;

  constructor(path = ":memory:") {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        title TEXT,
        added_at INTEGER NOT NULL,
        opened_at INTEGER NOT NULL,
        conversation_at INTEGER,
        body_mtime_ms REAL,
        created_at_ms REAL,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        archived_at INTEGER,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS annotation_events (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        thread_id TEXT,
        target_id TEXT,
        body TEXT,
        anchor_json TEXT,
        through_seq INTEGER,
        body_revision TEXT,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (document_id, seq)
      );
      CREATE INDEX IF NOT EXISTS annotation_events_thread ON annotation_events(document_id, thread_id, seq);
      CREATE TABLE IF NOT EXISTS acknowledgements (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        consumer TEXT NOT NULL,
        actor TEXT NOT NULL,
        cursor TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        body_revision TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, consumer)
      );
      CREATE TABLE IF NOT EXISTS review_observations (
        cursor TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        consumer TEXT NOT NULL,
        through_seq INTEGER NOT NULL,
        body_revision TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutations (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        operation_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reader_state (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        consumer TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (document_id, consumer)
      );
    `);
    const columns = this.db.query("PRAGMA table_info(acknowledgements)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "observation_order")) this.db.exec("ALTER TABLE acknowledgements ADD COLUMN observation_order INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`CREATE TABLE IF NOT EXISTS observation_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL);
      INSERT OR IGNORE INTO observation_clock VALUES(1,0);
      CREATE INDEX IF NOT EXISTS review_observations_expiry ON review_observations(created_at);
      CREATE INDEX IF NOT EXISTS annotation_events_target ON annotation_events(document_id,target_id,seq);
      CREATE TABLE IF NOT EXISTS agent_continuations (cursor TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_continuations_expiry ON agent_continuations(created_at);`);
    const observations = this.db.query("PRAGMA table_info(review_observations)").all() as { name: string }[];
    if (!observations.some((column) => column.name === "observation_order")) this.db.exec("ALTER TABLE review_observations ADD COLUMN observation_order INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`UPDATE review_observations SET observation_order=rowid WHERE observation_order=0;
      UPDATE acknowledgements SET observation_order=COALESCE((SELECT observation_order FROM review_observations WHERE review_observations.cursor=acknowledgements.cursor),0) WHERE observation_order=0;
      UPDATE observation_clock SET value=MAX(value,COALESCE((SELECT MAX(observation_order) FROM review_observations),0)) WHERE id=1;`);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }

  close(): void { this.db.close(); }

  ensureDocument(path: string, now = Date.now()): PrivateDocumentRow {
    this.db.query(`INSERT OR IGNORE INTO documents
      (id,path,title,added_at,opened_at,active,pinned)
      VALUES ($id,$path,NULL,$now,$now,1,0)`).run({ id: crypto.randomUUID(), path, now });
    return this.documentForPath(path)!;
  }

  documentForPath(path: string): PrivateDocumentRow | null {
    return this.db.query("SELECT * FROM documents WHERE path = ?").get(path) as PrivateDocumentRow | null;
  }

  private requireDocument(path: string): PrivateDocumentRow {
    const document = this.documentForPath(path);
    if (!document) throw new PrivateStoreDocumentNotFoundError();
    return document;
  }

  listDocuments(): PrivateDocumentRow[] {
    return this.db.query("SELECT * FROM documents ORDER BY opened_at DESC, path").all() as PrivateDocumentRow[];
  }

  events(path: string): AnnotationEvent[] {
    const document = this.documentForPath(path);
    if (!document) return [];
    return (this.db.query("SELECT payload_json FROM annotation_events WHERE document_id = ? ORDER BY seq").all(document.id) as EventRow[])
      .map((row) => JSON.parse(row.payload_json) as AnnotationEvent);
  }

  ledger(path: string, baseBodyRevision: string): AnnotationLedger {
    const document = this.requireDocument(path);
    return createAnnotationLedger({
      type: "ledger",
      documentId: document.id,
      baseBodyRevision,
      createdAt: new Date(document.added_at).toISOString(),
    }, this.events(path));
  }

  conversationRevision(path: string): string {
    return ledgerRevision(JSON.stringify(this.events(path)));
  }

  mutationReceipt(path: string, operationId: string, payloadHash: string): MutationReceipt | null {
    const document = this.documentForPath(path);
    if (!document) return null;
    const prior = this.db.query("SELECT payload_hash,result_json FROM mutations WHERE document_id = ? AND operation_id = ?")
      .get(document.id, operationId) as MutationRow | null;
    if (!prior) return null;
    if (prior.payload_hash !== payloadHash) throw new PrivateStoreConflictError("The operation ID was already used with a different payload.");
    return { ...(JSON.parse(prior.result_json) as MutationReceipt), replayed: true };
  }

  /** Receipts remain available for the lifetime of this conversation. */
  lookupMutation(path: string, operationId: string): { operationId: string; outcome: "applied" | "outcome_unknown"; receipt: MutationReceipt | null } {
    const document = this.requireDocument(path);
    const row = this.db.query("SELECT result_json FROM mutations WHERE document_id=? AND operation_id=?").get(document.id,operationId) as {result_json:string}|null;
    return { operationId, outcome: row ? "applied" : "outcome_unknown", receipt: row ? JSON.parse(row.result_json) as MutationReceipt : null };
  }

  appendEvent(input: {
    path: string;
    event: AnnotationEvent;
    operationId: string;
    payloadHash: string;
    expectedConversationRevision?: string;
    expectedThreadSequence?: number;
    now?: number;
  }): MutationReceipt {
    const transact = this.db.transaction((): MutationReceipt => {
      const document = this.requireDocument(input.path);
      const prior = this.db.query("SELECT payload_hash,result_json FROM mutations WHERE document_id = ? AND operation_id = ?")
        .get(document.id, input.operationId) as MutationRow | null;
      if (prior) {
        if (prior.payload_hash !== input.payloadHash) throw new PrivateStoreConflictError("The operation ID was already used with a different payload.");
        return { ...(JSON.parse(prior.result_json) as MutationReceipt), replayed: true };
      }
      const events = this.events(input.path);
      if (input.expectedConversationRevision !== undefined && input.expectedConversationRevision !== ledgerRevision(JSON.stringify(events))) {
        throw new PrivateStoreConflictError("The conversation changed before this mutation was applied.");
      }
      if (input.expectedThreadSequence !== undefined) {
        const threadId = input.event.type === "comment" || input.event.type === "ack" ? null : input.event.threadId;
        const latest = threadId ? deriveAnnotationState(events).byThread.get(threadId)?.latestEvent.seq : undefined;
        if (latest !== input.expectedThreadSequence) throw new PrivateStoreConflictError("The thread changed before this mutation was applied.");
      }
      const event = { ...input.event, seq: (events.at(-1)?.seq ?? 0) + 1 } as AnnotationEvent;
      appendAnnotationEvent(this.ledger(input.path, event.type === "ack" ? event.bodyRevision : "sha256:" + "0".repeat(64)), event);
      this.db.query(`INSERT INTO annotation_events
        (document_id,seq,id,type,actor,created_at,thread_id,target_id,body,anchor_json,through_seq,body_revision,payload_json)
        VALUES ($documentId,$seq,$id,$type,$actor,$createdAt,$threadId,$targetId,$body,$anchorJson,$throughSeq,$bodyRevision,$payloadJson)`)
        .run({
          documentId: document.id, seq: event.seq, id: event.id, type: event.type, actor: event.actor, createdAt: event.createdAt,
          threadId: "threadId" in event ? event.threadId : null, targetId: "targetId" in event ? event.targetId : null,
          body: "body" in event ? event.body : null, anchorJson: event.type === "comment" ? JSON.stringify(event.anchor) : null,
          throughSeq: event.type === "ack" ? event.throughSeq : null, bodyRevision: event.type === "ack" ? event.bodyRevision : null,
          payloadJson: JSON.stringify(event),
        });
      const receipt: MutationReceipt = { operationId: input.operationId, appliedEventId: event.id, appliedSequence: event.seq, eventId: event.id, sequence: event.seq, replayed: false };
      this.db.query("INSERT INTO mutations(document_id,operation_id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)")
        .run(document.id, input.operationId, input.payloadHash, JSON.stringify(receipt), input.now ?? Date.now());
      this.db.query("UPDATE documents SET conversation_at = ? WHERE id = ?").run(input.now ?? Date.now(), document.id);
      return receipt;
    });
    return transact.immediate();
  }

  replaceEvents(path: string, events: AnnotationEvent[], now = Date.now()): void {
    const document = this.requireDocument(path);
    createAnnotationLedger({
      type: "ledger", documentId: document.id,
      baseBodyRevision: "sha256:" + "0".repeat(64), createdAt: new Date(document.added_at).toISOString(),
    }, events);
    const transact = this.db.transaction(() => {
      const existing = this.db.query("SELECT COUNT(*) AS count FROM annotation_events WHERE document_id = ?").get(document.id) as { count: number };
      if (existing.count > 0) throw new PrivateStoreConflictError("The destination already has a conversation.");
      const insert = this.db.query(`INSERT INTO annotation_events
        (document_id,seq,id,type,actor,created_at,thread_id,target_id,body,anchor_json,through_seq,body_revision,payload_json)
        VALUES ($documentId,$seq,$id,$type,$actor,$createdAt,$threadId,$targetId,$body,$anchorJson,$throughSeq,$bodyRevision,$payloadJson)`);
      for (const event of events) insert.run({
        documentId: document.id, seq: event.seq, id: event.id, type: event.type, actor: event.actor, createdAt: event.createdAt,
        threadId: "threadId" in event ? event.threadId : null, targetId: "targetId" in event ? event.targetId : null,
        body: "body" in event ? event.body : null, anchorJson: event.type === "comment" ? JSON.stringify(event.anchor) : null,
        throughSeq: event.type === "ack" ? event.throughSeq : null, bodyRevision: event.type === "ack" ? event.bodyRevision : null,
        payloadJson: JSON.stringify(event),
      });
      this.db.query("UPDATE documents SET conversation_at = ? WHERE id = ?").run(events.length ? now : null, document.id);
    });
    transact.immediate();
  }

  observe(path: string, consumer: string, throughSequence: number, bodyRevision: string, now = Date.now()): ReviewObservation {
    const document = this.requireDocument(path);
    const cursor = `r-${crypto.randomUUID()}`;
    this.db.query("DELETE FROM review_observations WHERE created_at < ?").run(now - REVIEW_CURSOR_LIFETIME_MS);
    this.db.query("DELETE FROM agent_continuations WHERE created_at < ?").run(now - REVIEW_CURSOR_LIFETIME_MS);
    const order = this.db.query("UPDATE observation_clock SET value=value+1 WHERE id=1 RETURNING value").get() as {value:number};
    this.db.query("INSERT INTO review_observations(cursor,document_id,consumer,through_seq,body_revision,created_at,observation_order) VALUES (?,?,?,?,?,?,?)")
      .run(cursor, document.id, consumer, throughSequence, bodyRevision, now, order.value);
    return { cursor, documentId: document.id, consumer, throughSequence, bodyRevision, observationOrder: order.value };
  }

  observation(path: string, consumer: string, cursor: string, now = Date.now()): ReviewObservation {
    const document = this.documentForPath(path);
    const row = document && this.db.query("SELECT * FROM review_observations WHERE cursor = ? AND document_id = ? AND consumer = ?")
      .get(cursor, document.id, consumer) as { cursor: string; document_id: string; consumer: string; through_seq: number; body_revision: string; created_at:number; observation_order:number } | null;
    if (!row || row.created_at < now - REVIEW_CURSOR_LIFETIME_MS) throw new PrivateStoreConflictError("The reviewed cursor is invalid or expired; run pending again.");
    return { cursor: row.cursor, documentId: row.document_id, consumer: row.consumer, throughSequence: row.through_seq, bodyRevision: row.body_revision, observationOrder:row.observation_order };
  }

  acknowledgement(path: string, consumer: string): Record<string, unknown> | null {
    const document = this.documentForPath(path);
    if (!document) return null;
    const row = this.db.query("SELECT consumer,actor,cursor,through_seq,body_revision,updated_at FROM acknowledgements WHERE document_id = ? AND consumer = ?")
      .get(document.id, consumer) as Record<string, unknown> | null;
    return row ? { consumer: row.consumer, actor: row.actor, cursor: row.cursor, throughSeq: row.through_seq, bodyRevision: row.body_revision, updatedAt: row.updated_at } : null;
  }

  acknowledgements(path: string): Record<string, unknown>[] {
    const document = this.documentForPath(path);
    if (!document) return [];
    return (this.db.query("SELECT consumer,actor,cursor,through_seq,body_revision,updated_at FROM acknowledgements WHERE document_id = ? ORDER BY consumer")
      .all(document.id) as Array<Record<string, unknown>>).map((row) => ({
        consumer: row.consumer, actor: row.actor, cursor: row.cursor, throughSeq: row.through_seq,
        bodyRevision: row.body_revision, updatedAt: row.updated_at,
      }));
  }

  acknowledge(path: string, consumer: string, actor: string, cursor: string, now = Date.now()): ReviewObservation {
    const observation = this.observation(path, consumer, cursor, now);
    const document = this.documentForPath(path)!;
    const prior = this.acknowledgement(path, consumer) as { throughSeq?: number } | null;
    if ((prior?.throughSeq ?? 0) > observation.throughSequence) throw new PrivateStoreConflictError("A reviewed cursor cannot move acknowledgement backwards.");
    const priorOrder = this.db.query("SELECT observation_order FROM acknowledgements WHERE document_id=? AND consumer=?").get(document.id,consumer) as {observation_order:number}|null;
    if ((priorOrder?.observation_order ?? 0) > observation.observationOrder) throw new PrivateStoreConflictError("An older observation cannot replace a newer body acknowledgement.");
    this.db.query(`INSERT INTO acknowledgements(document_id,consumer,actor,cursor,through_seq,body_revision,updated_at,observation_order)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(document_id,consumer) DO UPDATE SET actor=excluded.actor,cursor=excluded.cursor,
      through_seq=excluded.through_seq,body_revision=excluded.body_revision,updated_at=excluded.updated_at,observation_order=excluded.observation_order`)
      .run(document.id, consumer, actor, cursor, observation.throughSequence, observation.bodyRevision, now, observation.observationOrder);
    return observation;
  }

  acknowledgeWithReceipt(input: {
    path: string; consumer: string; actor: string; cursor: string;
    operationId: string; payloadHash: string; now?: number;
  }): MutationReceipt {
    const transact = this.db.transaction((): MutationReceipt => {
      const document = this.requireDocument(input.path);
      const prior = this.db.query("SELECT payload_hash,result_json FROM mutations WHERE document_id = ? AND operation_id = ?")
        .get(document.id, input.operationId) as MutationRow | null;
      if (prior) {
        if (prior.payload_hash !== input.payloadHash) throw new PrivateStoreConflictError("The operation ID was already used with a different payload.");
        return { ...(JSON.parse(prior.result_json) as MutationReceipt), replayed: true };
      }
      const observation = this.acknowledge(input.path, input.consumer, input.actor, input.cursor, input.now);
      const receipt: MutationReceipt = { operationId: input.operationId, appliedEventId: null, appliedSequence: observation.throughSequence, eventId: null, sequence: observation.throughSequence, replayed: false };
      this.db.query("INSERT INTO mutations(document_id,operation_id,payload_hash,result_json,created_at) VALUES (?,?,?,?,?)")
        .run(document.id, input.operationId, input.payloadHash, JSON.stringify(receipt), input.now ?? Date.now());
      return receipt;
    });
    return transact.immediate();
  }

  locate(path: string, target: string): PrivateDocumentRow {
    const source = this.documentForPath(path);
    if (!source) throw new Error("Conversation not found.");
    if (this.documentForPath(target)) throw new PrivateStoreConflictError("The destination already has a Tether record.");
    this.db.query("UPDATE documents SET path = ? WHERE id = ?").run(target, source.id);
    return this.documentForPath(target)!;
  }

  deleteConversation(path: string): boolean {
    const document = this.documentForPath(path);
    if (!document) return false;
    const transact = this.db.transaction(() => {
      this.db.query("DELETE FROM mutations WHERE document_id = ?").run(document.id);
      this.db.query("DELETE FROM review_observations WHERE document_id = ?").run(document.id);
      this.db.query("DELETE FROM agent_continuations WHERE document_id = ?").run(document.id);
      this.db.query("DELETE FROM agent_continuations WHERE document_id = ?").run(document.id);
      this.db.query("DELETE FROM acknowledgements WHERE document_id = ?").run(document.id);
      this.db.query("DELETE FROM annotation_events WHERE document_id = ?").run(document.id);
      this.db.query("UPDATE documents SET conversation_at = NULL WHERE id = ?").run(document.id);
    });
    transact.immediate();
    return true;
  }
}
