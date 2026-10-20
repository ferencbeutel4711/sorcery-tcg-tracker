import { FOIL_FINISHES, type CardDb } from "./cards.ts";

export type MissingMode = "any" | "foil";

export interface MissingEntry {
  card: string;
  slug: string;
  type: string;
  rarity: string | null;
  /** Only set in "foil" mode: the specific treatment that's missing. */
  finish?: string;
  product?: string;
  printingSlug?: string;
  /** Cheapest Cardmarket price (EUR) to fill this gap, if known. */
  price: number | null;
}

/**
 * "any":  a card is missing when no printing of it in the set is owned.
 * "foil": every foil treatment (Foil, Rainbow) of every card in the set must be owned.
 */
export function missingForSet(
  cards: CardDb,
  collection: Record<string, number>,
  prices: Record<string, number>,
  set: string,
  mode: MissingMode,
) {
  const missing: MissingEntry[] = [];
  let total = 0;
  for (const card of cards.cards) {
    const inSet = card.printings.filter((p) => p.set === set);
    if (!inSet.length) continue;
    const base = { card: card.name, slug: card.slug, type: card.type, rarity: card.rarity };
    if (mode === "any") {
      total++;
      if (inSet.some((p) => collection[p.slug])) continue;
      const known = inSet.map((p) => prices[p.slug]).filter((v) => v != null);
      missing.push({ ...base, price: known.length ? Math.min(...known) : null });
    } else {
      for (const p of inSet.filter((p) => FOIL_FINISHES.has(p.finish))) {
        total++;
        if (!collection[p.slug]) missing.push({
          ...base, finish: p.finish, product: p.product, printingSlug: p.slug, price: prices[p.slug] ?? null,
        });
      }
    }
  }
  const cost = missing.reduce((sum, m) => sum + (m.price ?? 0), 0);
  const unpriced = missing.filter((m) => m.price == null).length;
  return { set, mode, total, missing, cost, unpriced };
}

const eur = (v: number | null) => (v == null ? "n/a" : `€${v.toFixed(2)}`);

export function missingAsText({ set, mode, total, missing, cost, unpriced }: ReturnType<typeof missingForSet>): string {
  const title = `${set} — missing ${mode === "foil" ? "foil treatments" : "cards"} (${missing.length} of ${total})`;
  const summary = `Estimated cost: ${eur(cost)}${unpriced ? ` (+${unpriced} without a Cardmarket price)` : ""}`;
  const lines = missing.map((m) =>
    (mode === "foil" ? `${m.card} [${m.finish}${m.product !== "Booster" ? `, ${m.product}` : ""}]` : `${m.card} (${m.rarity})`) +
    ` — ${eur(m.price)}`,
  );
  return [title, summary, "", ...lines, ""].join("\n");
}

/**
 * Cardmarket's wants-list "Add Deck List" import: one "<qty> <name>" per line, nothing else.
 * It can't express foil or treatment, so foil-mode gaps of one card collapse into a single line.
 */
export function missingAsCardmarket({ missing }: ReturnType<typeof missingForSet>): string {
  const counts = new Map<string, number>();
  for (const m of missing) counts.set(m.card, (counts.get(m.card) ?? 0) + 1);
  return [...counts].map(([name, qty]) => `${qty} ${name}`).join("\n") + "\n";
}
