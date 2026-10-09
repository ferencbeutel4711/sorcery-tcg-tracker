import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(new URL("../data/collection.db", import.meta.url).pathname);

db.exec(`
  CREATE TABLE IF NOT EXISTS collection (
    printing_slug TEXT PRIMARY KEY,
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`);

// Binder layout per set: ordered groups of card categories; each group starts a new page.
db.exec(`
  DROP TABLE IF EXISTS page_breaks;
  CREATE TABLE IF NOT EXISTS binder_layouts (
    set_name TEXT PRIMARY KEY,
    groups   TEXT NOT NULL
  )
`);

const selectAll = db.prepare("SELECT printing_slug AS slug, quantity FROM collection");
const upsert = db.prepare(`
  INSERT INTO collection (printing_slug, quantity) VALUES (?, ?)
  ON CONFLICT (printing_slug) DO UPDATE SET quantity = excluded.quantity,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
`);
const remove = db.prepare("DELETE FROM collection WHERE printing_slug = ?");

export function getCollection(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of selectAll.all() as { slug: string; quantity: number }[]) out[row.slug] = row.quantity;
  return out;
}

export function setQuantity(printingSlug: string, quantity: number): void {
  if (quantity > 0) upsert.run(printingSlug, quantity);
  else remove.run(printingSlug);
}

const selectLayouts = db.prepare("SELECT set_name AS setName, groups FROM binder_layouts");
const upsertLayout = db.prepare(`
  INSERT INTO binder_layouts (set_name, groups) VALUES (?, ?)
  ON CONFLICT (set_name) DO UPDATE SET groups = excluded.groups
`);

export function getBinderLayouts(): Record<string, string[][]> {
  const out: Record<string, string[][]> = {};
  for (const { setName, groups } of selectLayouts.all() as { setName: string; groups: string }[]) out[setName] = JSON.parse(groups);
  return out;
}

export function setBinderLayout(setName: string, groups: string[][]): void {
  upsertLayout.run(setName, JSON.stringify(groups));
}

/** Replaces the whole collection atomically. */
export function replaceCollection(entries: Record<string, number>): void {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM collection");
    for (const [slug, qty] of Object.entries(entries)) if (qty > 0) upsert.run(slug, qty);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
