// Sync to Curiosa (sorcerytcg.com) through the site's private tRPC API, authenticated with
// the user's browser session cookie. Undocumented, so expect this module to need fixes
// whenever the site changes.
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import type { CardDb } from "./cards.ts";

const ORIGIN = "https://sorcerytcg.com";
const COOKIE_FILE = new URL("../data/curiosa-cookie.txt", import.meta.url);
const QUERY_BATCH = 50; // card ids per inventory.quantities call (the site itself sends 20)
const UPDATE_BATCH = 25; // updateCard calls per batched request

export interface SyncChange {
  printingId: string;
  printingSlug: string;
  card: string;
  set: string;
  finish: string;
  product: string;
  from: number;
  to: number;
}

export class CuriosaError extends Error {}

export async function getCookie(): Promise<string | null> {
  try {
    return (await readFile(COOKIE_FILE, "utf8")).trim() || null;
  } catch {
    return null;
  }
}

export async function saveCookie(cookie: string): Promise<void> {
  // Accept a pasted "Cookie: ..." header line as well as the bare value.
  await writeFile(COOKIE_FILE, cookie.replace(/^cookie:\s*/i, "").trim());
  await chmod(COOKIE_FILE, 0o600);
}

export const clearCookie = () => rm(COOKIE_FILE, { force: true });

async function trpc(path: string, init: RequestInit = {}): Promise<any[]> {
  const cookie = await getCookie();
  if (!cookie) throw new CuriosaError("No Curiosa session set");
  const res = await fetch(`${ORIGIN}/api/trpc/${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-trpc-source": "nextjs-react",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/collection/edit`,
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: any[];
  try {
    body = JSON.parse(text);
  } catch {
    throw new CuriosaError(`Unexpected response from Curiosa (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  const err = body.find?.((r: any) => r.error)?.error?.json;
  if (err?.data?.code === "UNAUTHORIZED") throw new CuriosaError("Curiosa session expired or invalid — paste a fresh cookie");
  if (err) throw new CuriosaError(`Curiosa error: ${err.message}`);
  return body.map((r) => r.result?.data?.json);
}

/** inventory.quantities returns `{ [printingId]: { quantity, notes } }` for owned printings only. */
function collectQuantities(result: unknown, out: Map<string, number>): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new CuriosaError(`Unexpected inventory.quantities response: ${JSON.stringify(result)?.slice(0, 200)}`);
  }
  for (const [printingId, entry] of Object.entries(result)) {
    const quantity = (entry as { quantity?: unknown })?.quantity;
    if (typeof quantity !== "number") {
      throw new CuriosaError(`Unexpected quantity entry for ${printingId}: ${JSON.stringify(entry)?.slice(0, 200)}`);
    }
    out.set(printingId, quantity);
  }
}

async function fetchRemoteQuantities(cardIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < cardIds.length; i += QUERY_BATCH) {
    const input = { 0: { json: { cardIds: cardIds.slice(i, i + QUERY_BATCH) } } };
    const [result] = await trpc(`inventory.quantities?batch=1&input=${encodeURIComponent(JSON.stringify(input))}`);
    collectQuantities(result, out);
  }
  return out;
}

/** Diffs the local collection against Curiosa. Only printings the app knows (e.g. not Alpha) are touched. */
export async function planSync(cards: CardDb, collection: Record<string, number>): Promise<SyncChange[]> {
  const remote = await fetchRemoteQuantities(cards.cards.map((c) => c.id));
  const changes: SyncChange[] = [];
  for (const card of cards.cards) {
    for (const p of card.printings) {
      const from = remote.get(p.id) ?? 0;
      const to = collection[p.slug] ?? 0;
      if (from !== to) {
        changes.push({
          printingId: p.id, printingSlug: p.slug, card: card.name, set: p.set,
          finish: p.finish, product: p.product, from, to,
        });
      }
    }
  }
  return changes;
}

/** Writes absolute quantities, so re-running after a partial failure is safe. */
export async function applySync(changes: SyncChange[]): Promise<number> {
  let done = 0;
  for (let i = 0; i < changes.length; i += UPDATE_BATCH) {
    const chunk = changes.slice(i, i + UPDATE_BATCH);
    const body = Object.fromEntries(chunk.map((c, j) => [j, { json: { printingId: c.printingId, quantity: c.to } }]));
    await trpc(`${Array(chunk.length).fill("inventory.updateCard").join(",")}?batch=1`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    done += chunk.length;
  }
  return done;
}
