import type { CardDb } from "./cards.ts";

const HEADER = ["Card Name", "Card Slug", "Quantity", "Set Name", "Printed At", "Product", "Finish", "Notes"];

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  text = text.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f !== ""));
}

const quote = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;

/** Maps a Curiosa collection export onto printing slugs. Returns unmatched rows for reporting. */
export function importCuriosaCsv(text: string, cards: CardDb) {
  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`CSV is missing column "${name}"`);
    return i;
  };
  const [slugI, qtyI, setI, printedI, productI, finishI] =
    ["Card Slug", "Quantity", "Set Name", "Printed At", "Product", "Finish"].map(col);

  const entries: Record<string, number> = {};
  const unmatched: string[][] = [];
  for (const r of rows) {
    const card = cards.bySlug.get(r[slugI]);
    const matches = card?.printings.filter(
      (p) => p.set === r[setI] && p.product === r[productI] && p.finish === r[finishI],
    ) ?? [];
    // Printed At disambiguates the rare cards with several printings per set/product/finish.
    const printing = matches.find((p) => p.printedAt === r[printedI]) ?? matches[0];
    if (!printing) unmatched.push(r);
    else entries[printing.slug] = (entries[printing.slug] ?? 0) + Number(r[qtyI]);
  }
  return { entries, unmatched };
}

export function exportCuriosaCsv(collection: Record<string, number>, cards: CardDb): string {
  const lines = [HEADER.join(",")];
  const rows = Object.entries(collection)
    .map(([slug, qty]) => ({ hit: cards.printingBySlug.get(slug), qty }))
    .filter((r) => r.hit)
    .sort((a, b) => a.hit!.card.name.localeCompare(b.hit!.card.name));
  for (const { hit, qty } of rows) {
    const { card, printing: p } = hit!;
    lines.push([card.name, card.slug, qty, p.set, p.printedAt, p.product, p.finish, ""].map(quote).join(","));
  }
  return "﻿" + lines.join("\n") + "\n";
}
