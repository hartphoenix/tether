import type { Database } from "bun:sqlite";

/** Small, bounded ceremony records; bearer secrets must never be values. */
export class DurableMap<T> extends Map<string, T> {
  constructor(private readonly db: Database, private readonly namespace: string) {
    super();
    db.exec("CREATE TABLE IF NOT EXISTS ceremonies (namespace TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(namespace,id))");
    for (const row of db.query("SELECT id,value FROM ceremonies WHERE namespace=?").all(namespace) as {id:string;value:string}[]) super.set(row.id, JSON.parse(row.value));
  }
  override set(id: string, value: T): this {
    this.db.query("INSERT OR REPLACE INTO ceremonies(namespace,id,value) VALUES(?,?,?)").run(this.namespace, id, JSON.stringify(value));
    return super.set(id, value);
  }
  override delete(id: string): boolean {
    this.db.query("DELETE FROM ceremonies WHERE namespace=? AND id=?").run(this.namespace, id);
    return super.delete(id);
  }
  override clear(): void {
    this.db.query("DELETE FROM ceremonies WHERE namespace=?").run(this.namespace);
    super.clear();
  }
}
