import { readFile, writeFile } from "node:fs/promises";
import { FOIL_FINISHES, type CardDb } from "./cards.ts";

// Cardmarket publishes daily product/price dumps per game; Sorcery is game 25.
const BASE = "https://downloads.s3.cardmarket.com/productCatalog";
const PRODUCTS_URL = `${BASE}/productList/products_singles_25.json`;
const PRICES_URL = `${BASE}/priceGuide/price_guide_25.json`;
const CACHE_FILE = new URL("../data/prices.json", import.meta.url);

// The dumps carry no expansion names. Mapped by matching card names; Beta vs Alpha (6771,
// identical card lists, not collected) was told apart by Alpha's much higher prices.
const EXPANSIONS: Record<string, number> = {
  Beta: 6775,
  "Arthurian Legends": 6778,
  Gothic: 6779,
  Promo: 6780,
  Dragonlord: 6781,
};

// Preference order: trend is Cardmarket's headline price but is often empty for this young market.
const FIELDS = ["trend", "avg30", "avg7", "avg", "low"];

export interface PriceDb {
  fetchedAt: string;
  /** EUR price per printing slug; printings without a market price are absent. */
  prices: Record<string, number>;
  /** Cardmarket product id per printing slug, for linking. */
  products: Record<string, number>;
}

function pick(guide: any, foil: boolean): number | null {
  for (const field of FIELDS) {
    const v = guide[foil ? `${field}-foil` : field];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

function buildPrices(products: any[], guides: any[], cards: CardDb, fetchedAt: string): PriceDb {
  const guideById = new Map(guides.map((g) => [g.idProduct, g]));
  // A few names appear twice per expansion (alt arts, deck versions); the lowest id is the original.
  const byKey = new Map<string, any>();
  for (const p of [...products].sort((a, b) => a.idProduct - b.idProduct)) {
    const key = `${p.idExpansion}|${p.name.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, p);
  }

  const prices: Record<string, number> = {};
  const productIds: Record<string, number> = {};
  for (const card of cards.cards) {
    for (const printing of card.printings) {
      const product = byKey.get(`${EXPANSIONS[printing.set]}|${card.name.toLowerCase()}`);
      if (!product) continue;
      productIds[printing.slug] = product.idProduct;
      const guide = guideById.get(product.idProduct);
      const price = guide && pick(guide, FOIL_FINISHES.has(printing.finish));
      if (price) prices[printing.slug] = price;
    }
  }
  return { fetchedAt, prices, products: productIds };
}

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** Downloads the current Cardmarket price guide; falls back to the on-disk cache when offline. */
export async function loadPrices(cards: CardDb): Promise<PriceDb> {
  let raw: { fetchedAt: string; products: any[]; guides: any[] };
  try {
    const [products, guides] = await Promise.all([getJson(PRODUCTS_URL), getJson(PRICES_URL)]);
    raw = { fetchedAt: guides.createdAt, products: products.products, guides: guides.priceGuides };
    await writeFile(CACHE_FILE, JSON.stringify(raw));
  } catch (err) {
    console.warn(`Cardmarket unavailable (${(err as Error).message}), using cached prices`);
    try {
      raw = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    } catch {
      return { fetchedAt: "", prices: {}, products: {} };
    }
  }
  const db = buildPrices(raw.products, raw.guides, cards, raw.fetchedAt);
  console.log(`Prices for ${Object.keys(db.prices).length} printings (Cardmarket guide of ${raw.fetchedAt})`);
  return db;
}
