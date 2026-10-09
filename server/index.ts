import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, normalize, join } from "node:path";
import { loadCards } from "./cards.ts";
import { getBinderLayouts, getCollection, replaceCollection, setBinderLayout, setQuantity } from "./db.ts";
import { exportCuriosaCsv, importCuriosaCsv } from "./csv.ts";
import { applySync, clearCookie, CuriosaError, getCookie, planSync, saveCookie } from "./curiosa.ts";
import { loadPrices, type PriceDb } from "./prices.ts";
import { missingAsText, missingForSet, type MissingMode } from "./missing.ts";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;
/** Binder categories; the client assigns each card to exactly one. */
const BINDER_CATEGORIES = ["boxtopper", "avatar", "site", "artifact", "multi", "air", "earth", "fire", "water"];
const IMAGE_CDN = "https://d27a44hjr9gen3.cloudfront.net/cards";
const IMAGE_DIR = new URL("../data/images/", import.meta.url).pathname;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const cards = await loadCards();
// Cardmarket regenerates its price guide daily, so refresh prices while the server runs.
let prices: PriceDb = await loadPrices(cards);
setInterval(async () => (prices = await loadPrices(cards)), 24 * 60 * 60 * 1000).unref();
// The client payload never changes while the server runs, so serialize it once.
const cardsPayload = JSON.stringify({ fetchedAt: cards.fetchedAt, sets: cards.sets, cards: cards.cards });

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body: string, type = "application/json; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(body);
}
const json = (res: ServerResponse, data: unknown, status = 200) => send(res, status, JSON.stringify(data));

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/cards") return send(res, 200, cardsPayload, undefined, { "Cache-Control": "no-cache" });

  if (route === "GET /api/collection") return json(res, getCollection());

  if (route === "GET /api/prices") return json(res, prices);

  if (route === "GET /api/binder") return json(res, getBinderLayouts());
  const binderMatch = url.pathname.match(/^\/api\/binder\/([^/]+)$/);
  if (binderMatch && req.method === "PUT") {
    const setName = decodeURIComponent(binderMatch[1]);
    if (!cards.sets.includes(setName)) return json(res, { error: "Unknown set" }, 404);
    const { groups } = JSON.parse(await readBody(req));
    const flat = Array.isArray(groups) && groups.every((g) => Array.isArray(g) && g.length) ? groups.flat() : [];
    const valid = flat.length === BINDER_CATEGORIES.length && BINDER_CATEGORIES.every((c) => flat.includes(c));
    if (!valid) return json(res, { error: `groups must partition ${BINDER_CATEGORIES.join(", ")}` }, 400);
    setBinderLayout(setName, groups);
    return json(res, getBinderLayouts());
  }

  const qtyMatch = url.pathname.match(/^\/api\/collection\/([^/]+)$/);
  if (qtyMatch && req.method === "PUT") {
    const slug = decodeURIComponent(qtyMatch[1]);
    if (!cards.printingBySlug.has(slug)) return json(res, { error: "Unknown printing" }, 404);
    const { quantity } = JSON.parse(await readBody(req));
    if (!Number.isInteger(quantity) || quantity < 0) return json(res, { error: "Invalid quantity" }, 400);
    setQuantity(slug, quantity);
    return json(res, { slug, quantity });
  }

  if (route === "POST /api/import") {
    const { entries, unmatched } = importCuriosaCsv(await readBody(req), cards);
    replaceCollection(entries);
    return json(res, { imported: Object.keys(entries).length, unmatched });
  }

  if (route === "GET /api/export.csv") {
    return send(res, 200, exportCuriosaCsv(getCollection(), cards), "text/csv; charset=utf-8", {
      "Content-Disposition": 'attachment; filename="sorcery-collection.csv"',
    });
  }

  if (route === "GET /api/missing") {
    const set = url.searchParams.get("set") ?? "";
    const mode = (url.searchParams.get("mode") === "foil" ? "foil" : "any") as MissingMode;
    if (!cards.sets.includes(set)) return json(res, { error: "Unknown set" }, 404);
    const result = missingForSet(cards, getCollection(), prices.prices, set, mode);
    if (url.searchParams.get("format") !== "txt") return json(res, result);
    return send(res, 200, missingAsText(result), "text/plain; charset=utf-8", {
      "Content-Disposition": `attachment; filename="missing-${set.replaceAll(" ", "-").toLowerCase()}-${mode}.txt"`,
    });
  }

  if (route === "GET /api/sync/session") return json(res, { connected: !!(await getCookie()) });
  if (route === "PUT /api/sync/session") {
    const { cookie } = JSON.parse(await readBody(req));
    if (typeof cookie !== "string" || !cookie.trim()) return json(res, { error: "Cookie is empty" }, 400);
    await saveCookie(cookie);
    return json(res, { connected: true });
  }
  if (route === "DELETE /api/sync/session") {
    await clearCookie();
    return json(res, { connected: false });
  }
  // Preview and apply both diff against Curiosa's live state, so apply never acts on a stale preview.
  if (route === "POST /api/sync/preview" || route === "POST /api/sync/apply") {
    try {
      const changes = await planSync(cards, getCollection());
      if (route.endsWith("preview")) return json(res, { changes });
      return json(res, { applied: await applySync(changes) });
    } catch (err) {
      if (err instanceof CuriosaError) return json(res, { error: err.message }, 502);
      throw err;
    }
  }

  json(res, { error: "Not found" }, 404);
}

/** Proxies card art from the CDN, caching each image on disk so it is only downloaded once. */
async function serveImage(res: ServerResponse, slug: string) {
  if (!cards.printingBySlug.has(slug)) return send(res, 404, "Not found", "text/plain");
  const file = join(IMAGE_DIR, `${slug}.png`);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    const upstream = await fetch(`${IMAGE_CDN}/${slug}.png`);
    if (!upstream.ok) return send(res, 502, "Image unavailable", "text/plain");
    data = Buffer.from(await upstream.arrayBuffer());
    await mkdir(IMAGE_DIR, { recursive: true });
    await writeFile(file, data);
  }
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
  res.end(data);
}

async function serveStatic(res: ServerResponse, pathname: string) {
  const file = normalize(join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden", "text/plain");
  try {
    send(res, 200, await readFile(file, "utf8"), MIME[extname(file)] ?? "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const img = url.pathname.match(/^\/img\/([\w-]+)\.png$/);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (img) await serveImage(res, img[1]);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err);
    json(res, { error: (err as Error).message }, 500);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Sorcery tracker on http://localhost:${PORT}`));
