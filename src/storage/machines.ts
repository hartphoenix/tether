import type { Database } from "bun:sqlite";
import type { FileMachine } from "../shared/machine-path";

/** Retained identities outlive connector credentials and temporary outages. */
export class Machines {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS file_machines (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
      qualify_paths INTEGER NOT NULL DEFAULT 0 CHECK(qualify_paths IN (0,1))
    )`);
  }
  list(): FileMachine[] {
    return (this.db.query("SELECT id,name,qualify_paths FROM file_machines ORDER BY name_key").all() as { id: string; name: string; qualify_paths: number }[])
      .map(row => ({ id: row.id, name: row.name, qualifyPaths: !!row.qualify_paths }));
  }
  get(id: string): FileMachine | undefined { return this.list().find(machine => machine.id === id); }
  set(id: string, name: string, qualifyPaths = this.get(id)?.qualifyPaths ?? false): FileMachine {
    name = name.trim().normalize("NFC");
    if (!/^[a-f0-9-]{36}$/i.test(id) || !name || name.length > 100 || /[\p{Cc}:]/u.test(name) || typeof qualifyPaths !== "boolean") {
      throw Object.assign(new Error("Use a machine name of 1–100 characters without colons or control characters."), { code: "invalid_machine", status: 400 });
    }
    const key = name.toLocaleLowerCase("en-US");
    if (this.list().some(machine => machine.id !== id && machine.name.toLocaleLowerCase("en-US") === key)) {
      throw Object.assign(new Error("Another machine already uses this name."), { code: "machine_name_taken", status: 409 });
    }
    this.db.query("INSERT INTO file_machines(id,name,name_key,qualify_paths) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key,qualify_paths=excluded.qualify_paths")
      .run(id, name, key, Number(qualifyPaths));
    return { id, name, qualifyPaths };
  }
}
