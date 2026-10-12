// Last edited: 2026-10-11 19:45 PDT
// A new project's home starts with an empty database file. The daemon crash-looped on it with
// "no such table: runs" because the run watcher prepared statements before the tables existed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMigrations, openMigratedDb, schemaVersion } from "../src/db/index.ts";
import { createRunWaiter } from "../src/plan/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "marshall-fresh-db-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("openMigratedDb", () => {
  test("an empty file gets the full schema, and the run watcher starts on it", () => {
    const db = openMigratedDb(join(dir, "marshall.db"));
    expect(schemaVersion(db)).toBe(listMigrations().at(-1)?.version as number);
    const waiter = createRunWaiter(db);
    waiter.stop();
    db.close();
  });

  test("opening an up-to-date database again changes nothing", () => {
    const path = join(dir, "marshall.db");
    openMigratedDb(path).close();
    const again = openMigratedDb(path);
    expect(schemaVersion(again)).toBe(listMigrations().at(-1)?.version as number);
    again.close();
  });
});
