import { readFile, writeFile } from "node:fs/promises";

const API_URL = "https://api.sorcerytcg.com/api/cards";
const CACHE_FILE = new URL("../data/cards.json", import.meta.url);

/** Sets the user doesn't collect; their printings are dropped entirely. */
const EXCLUDED_SETS = new Set(["Alpha"]);

/**
 * Minions the API lists without elements (no threshold) that still carry an element-coloured
 * frame. Read off the card art so they sort and filter with their colour.
 */
const FRAME_ELEMENTS: Record<string, string> = {
  blacksmith_family: "Fire",
  bruin: "Earth",
  common_cottagers: "Earth",
  foot_soldier: "Earth",
  castle_servants: "Air",
  skeleton: "Air",
  tawny: "Air",
  fishermans_family: "Water",
  frog: "Water",
};

export const FOIL_FINISHES = new Set(["Foil", "Rainbow"]);

export interface Printing {
  /** Curiosa's printing id, needed for syncing. */
  id: string;
  slug: string;
  set: string;
  finish: string;
  product: string;
  printedAt: string;
  artist: string | null;
}

export interface Card {
  id: string;
  slug: string;
  name: string;
  type: string;
  rarity: string | null;
  cost: number | null;
  rules: string | null;
  elements: string[];
  subtypes: string[];
  printings: Printing[];
}

export interface CardDb {
  fetchedAt: string;
  sets: string[];
  cards: Card[];
  bySlug: Map<string, Card>;
  printingBySlug: Map<string, { card: Card; printing: Printing }>;
}

function elementsOf(c: any): string[] {
  const elements = (c.engine.elements ?? []).filter((e: string) => e !== "None");
  return elements.length || !FRAME_ELEMENTS[c.slug] ? elements : [FRAME_ELEMENTS[c.slug]];
}

function normalize(raw: any[]): Card[] {
  const cards: Card[] = raw.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    type: c.engine.type,
    rarity: c.engine.rarity ?? null,
    cost: c.engine.cost ?? null,
    rules: c.engine.rules ?? null,
    elements: elementsOf(c),
    subtypes: c.engine.subtypes ?? [],
    printings: c.printings.map((p: any) => ({
      id: p.id,
      slug: p.slug,
      set: p.set.name,
      finish: p.meta.finish,
      product: p.meta.product,
      printedAt: p.printedAt,
      artist: p.meta.artist?.name ?? null,
    })).filter((p: Printing) => !EXCLUDED_SETS.has(p.set)),
  }));
  return cards.filter((c) => c.printings.length);
}

function buildDb(raw: any[], fetchedAt: string): CardDb {
  const cards = normalize(raw).sort((a, b) => a.name.localeCompare(b.name));
  // Order sets by their earliest printing date; the API's releasedAt is unreliable.
  const firstPrint = new Map<string, string>();
  for (const c of cards) {
    for (const p of c.printings) {
      const prev = firstPrint.get(p.set);
      if (!prev || p.printedAt < prev) firstPrint.set(p.set, p.printedAt);
    }
  }
  // Promos span every release, so they go last.
  const sets = [...firstPrint.keys()].sort(
    (a, b) => Number(a === "Promo") - Number(b === "Promo") || firstPrint.get(a)!.localeCompare(firstPrint.get(b)!),
  );
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const printingBySlug = new Map<string, { card: Card; printing: Printing }>();
  for (const card of cards) for (const printing of card.printings) printingBySlug.set(printing.slug, { card, printing });
  return { fetchedAt, sets, cards, bySlug, printingBySlug };
}

/** Fetches card metadata once; falls back to the on-disk cache when the API is unreachable. */
export async function loadCards(): Promise<CardDb> {
  try {
    const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const fetchedAt = new Date().toISOString();
    await writeFile(CACHE_FILE, JSON.stringify({ fetchedAt, raw }));
    console.log(`Fetched ${raw.length} cards from ${API_URL}`);
    return buildDb(raw, fetchedAt);
  } catch (err) {
    console.warn(`Card API unavailable (${(err as Error).message}), using cache`);
    const { fetchedAt, raw } = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    return buildDb(raw, fetchedAt);
  }
}
