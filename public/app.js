const TYPES = ["Avatar", "Minion", "Magic", "Aura", "Artifact", "Site"];
const ELEMENTS = ["Air", "Earth", "Fire", "Water"];
const RARITIES = ["Ordinary", "Exceptional", "Elite", "Unique"];
const FOILS = new Set(["Foil", "Rainbow"]);
/** Binder page layouts as [columns, rows]. */
const BINDERS = { "3x3": [3, 3], "4x3": [4, 3] };
const ALL = "__all__";

const $ = (sel) => document.querySelector(sel);
const eur = (v) => (v == null ? "–" : `€${v.toFixed(2)}`);
const cmLink = (name) => `https://www.cardmarket.com/en/Sorcery/Products/Search?searchString=${encodeURIComponent(name)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  sets: [],
  cards: [],
  collection: {},
  prices: {},
  set: load("set", ALL),
  view: "cards",
  search: "",
  types: new Set(),
  rarities: new Set(),
  elements: new Set(),
  elCount: "",
  owned: "",
  mode: "any",
  minPrice: Number(load("minPrice", 0)) || 0,
  layout: load("layout", "grid"),
  sort: load("sort", "name"),
  /** Quick edit target finish ("Standard" | "Foil"), or "" when quick edit is off. */
  quick: load("quick", ""),
  /** Per set: binder layout as ordered groups of categories. */
  binder: {},
};

function load(key, fallback) {
  try { return localStorage.getItem(`st.${key}`) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(`st.${key}`, value); } catch {}
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 2500);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

// ---- derived data ------------------------------------------------------------

const printingsInScope = (card) => (state.set === ALL ? card.printings : card.printings.filter((p) => p.set === state.set));
const ownedOf = (printings) => printings.reduce((n, p) => n + (state.collection[p.slug] ?? 0), 0);
/** Collection value, counting only printings priced at or above the user's minimum. */
function worthOf(printings) {
  return printings.reduce((sum, p) => {
    const price = state.prices[p.slug] ?? 0;
    return price >= state.minPrice ? sum + (state.collection[p.slug] ?? 0) * price : sum;
  }, 0);
}

/** Picks the printing to show on a tile: an owned one if possible, otherwise the plain booster print. */
function coverPrinting(printings) {
  const rank = (p) => (state.collection[p.slug] ? 0 : 2) + (p.finish === "Standard" && p.product === "Booster" ? 0 : 1);
  return [...printings].sort((a, b) => rank(a) - rank(b))[0];
}

/** Single elements in rules order, then multi-element, then element-less cards. */
const elementRank = (c) => (c.elements.length === 0 ? 6 : c.elements.length > 1 ? 5 : ELEMENTS.indexOf(c.elements[0]));
const SORT_KEYS = {
  name: () => 0,
  element: elementRank,
  type: (c) => TYPES.indexOf(c.type),
  rarity: (c) => { const i = RARITIES.indexOf(c.rarity); return i < 0 ? 99 : i; },
  cost: (c) => c.cost ?? 99,
};
const compareCards = (a, b) => SORT_KEYS[state.sort](a) - SORT_KEYS[state.sort](b) || a.name.localeCompare(b.name);

function matches(card) {
  const n = card.elements.length;
  if (state.types.size && !state.types.has(card.type)) return false;
  if (state.rarities.size && !state.rarities.has(card.rarity)) return false;
  if (state.elCount === "none" && n !== 0) return false;
  if (state.elCount === "single" && n !== 1) return false;
  if (state.elCount === "multi" && n < 2) return false;
  if (state.elements.size && !card.elements.some((e) => state.elements.has(e))) return false;
  if (state.search) {
    const q = state.search.toLowerCase();
    if (!card.name.toLowerCase().includes(q) && !(card.rules ?? "").toLowerCase().includes(q)) return false;
  }
  if (state.owned) {
    const owned = ownedOf(printingsInScope(card)) > 0;
    if ((state.owned === "owned") !== owned) return false;
  }
  return true;
}

// ---- rendering ---------------------------------------------------------------

function renderSets() {
  const tabs = [[ALL, "All sets"], ...state.sets.map((s) => [s, s])];
  $("#sets").innerHTML = tabs
    .map(([v, label]) => `<button data-v="${esc(v)}" class="${v === state.set ? "on" : ""}">${esc(label)}</button>`)
    .join("");
}

function renderChips() {
  $("#types").innerHTML = TYPES.map((t) => `<button data-v="${t}" class="chip">${t}</button>`).join("");
  $("#rarities").innerHTML = RARITIES.map((r) => `<button data-v="${r}" class="chip rarity-${r.toLowerCase()}">${r}</button>`).join("");
  $("#elements").innerHTML = ELEMENTS.map((e) => `<button data-v="${e}" class="chip el-${e.toLowerCase()}">${e}</button>`).join("");
}

function elementDots(card) {
  return card.elements.map((e) => `<i class="dot el-${e.toLowerCase()}" title="${e}"></i>`).join("");
}

/**
 * The printing quick edit's +/− act on: the chosen finish, preferring the booster print and,
 * when several sets are in scope, the newest set.
 */
function quickPrinting(printings) {
  const ofFinish = printings.filter((p) => (state.quick === "Foil" ? FOILS.has(p.finish) : p.finish === "Standard"));
  const rank = (p) => (p.product === "Booster" ? 0 : 100) - state.sets.indexOf(p.set);
  return ofFinish.sort((a, b) => rank(a) - rank(b))[0];
}

function quickHtml(printings) {
  const target = quickPrinting(printings);
  if (!target) return `<div class="quick muted">no ${state.quick.toLowerCase()} print</div>`;
  const q = state.collection[target.slug] ?? 0;
  const label = `${state.set === ALL ? `${target.set} · ` : ""}${state.quick === "Foil" ? `✦ ${target.finish}` : "Standard"}`;
  return `<div class="quick" data-printing="${esc(target.slug)}" title="${esc(label)}">
    <button data-delta="-1" aria-label="Remove one" ${q ? "" : "disabled"}>−</button>
    <span><b>${q}</b> <small>${esc(label)}</small></span>
    <button data-delta="1" aria-label="Add one">+</button>
  </div>`;
}

function tileHtml(card) {
  const printings = printingsInScope(card);
  const cover = coverPrinting(printings);
  const owned = ownedOf(printings);
  const foils = ownedOf(printings.filter((p) => FOILS.has(p.finish)));
  return `<div class="tile ${owned ? "owned" : ""}">
    <button class="open" data-card="${esc(card.slug)}">
      <img loading="lazy" src="/img/${esc(cover.slug)}.png" alt="${esc(card.name)}">
      <span class="meta"><span class="name">${elementDots(card)}${esc(card.name)}</span>
      <span class="qty">${owned ? `${owned}×${foils ? ` <b title="foil">✦${foils}</b>` : ""}` : "—"}</span>
      <span class="price">${eur(state.prices[cover.slug])}</span></span>
    </button>
    ${state.quick ? quickHtml(printings) : ""}
  </div>`;
}

function renderGrid() {
  const inScope = state.cards.filter((c) => printingsInScope(c).length);
  const shown = inScope.filter(matches).sort(compareCards); // binder mode re-sorts per group
  const ownedCards = inScope.filter((c) => ownedOf(printingsInScope(c)) > 0).length;
  const binder = BINDERS[state.layout];
  if (binder) {
    renderBinderConfig();
    $("#binder").innerHTML = binderHtml(shown, ...binder);
    $("#binder").style.setProperty("--cols", binder[0]);
  }
  else $("#grid").innerHTML = shown.map(tileHtml).join("");
  const worth = inScope.reduce((sum, c) => sum + worthOf(printingsInScope(c)), 0);
  $("#stats").innerHTML =
    `Showing ${shown.length} of ${inScope.length} cards · ${ownedCards}/${inScope.length} owned` +
    ` (${Math.round((ownedCards / Math.max(inScope.length, 1)) * 100)}%) · collection worth <strong>${eur(worth)}</strong>` +
    (state.minPrice > 0 ? ` <span class="muted">(cards ≥ ${eur(state.minPrice)})</span>` : "") +
    (binder ? ` · ${Math.ceil(shown.length / (binder[0] * binder[1]))} binder pages` : "");
}

// ---- binder --------------------------------------------------------------------

const BINDER_CATEGORIES = {
  boxtopper: "Box toppers",
  avatar: "Avatars",
  site: "Sites",
  artifact: "Artifacts",
  multi: "Multi-element",
  air: "Air",
  earth: "Earth",
  fire: "Fire",
  water: "Water",
};
const DEFAULT_GROUPS = [["avatar"], ["air"], ["earth"], ["fire"], ["water"], ["multi"], ["artifact"], ["site"], ["boxtopper"]];

/**
 * Every card falls in exactly one category; earlier checks win (a multi-element site is a site).
 * Box toppers are cards that only exist as box-topper prints in scope (not e.g. Beta's Sorcerer,
 * which also has booster prints). Element-less minions/spells don't exist today (the server
 * assigns frame colours); should one appear, it goes with the other colourless cards, artifacts.
 */
function binderCategory(card) {
  if (printingsInScope(card).every((p) => p.product === "BoxTopper")) return "boxtopper";
  if (card.type === "Avatar") return "avatar";
  if (card.type === "Site") return "site";
  if (card.type === "Artifact") return "artifact";
  if (card.elements.length > 1) return "multi";
  return card.elements.length ? card.elements[0].toLowerCase() : "artifact";
}

/** The set's saved layout, with categories added since it was saved appended as their own groups. */
function binderGroups() {
  const saved = (state.set !== ALL && state.binder[state.set]) || DEFAULT_GROUPS;
  const groups = saved.map((g) => g.filter((c) => c in BINDER_CATEGORIES)).filter((g) => g.length);
  const known = new Set(groups.flat());
  for (const c of Object.keys(BINDER_CATEGORIES)) if (!known.has(c)) groups.push([c]);
  return groups;
}

/**
 * Lays cards out as binder pages of cols × rows pockets, filled row by row. Each group starts on
 * a new page; within a group, categories follow one another in order, each sorted alphabetically.
 */
function binderHtml(cards, cols, rows) {
  const perPage = cols * rows;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const pages = [];
  for (const group of binderGroups()) {
    const inGroup = group.flatMap((cat) => cards.filter((c) => binderCategory(c) === cat).sort(byName));
    for (let i = 0; i < inGroup.length; i += perPage) {
      const page = inGroup.slice(i, i + perPage);
      const cats = [...new Set(page.map(binderCategory))];
      const continued = i > 0 && binderCategory(inGroup[i - 1]) === cats[0];
      const label = cats.map((c, k) => BINDER_CATEGORIES[c] + (k === 0 && continued ? " (cont.)" : "")).join(" + ");
      pages.push({ label, cards: page });
    }
  }
  if (!pages.length) return `<p class="empty">No cards match.</p>`;
  return pages.map(({ label, cards: page }, i) => `<section class="page">
      <h3 class="divider"><span>Page ${i + 1}</span> <small>${esc(label)} · ${page.length}/${perPage}</small></h3>
      <div class="slots" style="--cols:${cols}">${page.map((c) => tileHtml(c)).join("")}${`<div class="slot"></div>`.repeat(perPage - page.length)}</div>
    </section>`).join("");
}

/** Editor: category chips in order, with a page-break toggle between each neighbouring pair. */
function renderBinderConfig() {
  const box = $("#binder-config");
  const editable = state.set !== ALL;
  const groups = binderGroups();
  const order = groups.flat();
  const counts = Object.fromEntries(order.map((c) => [c, 0]));
  for (const card of state.cards) if (printingsInScope(card).length && matches(card)) counts[binderCategory(card)]++;
  const parts = [];
  let index = 0;
  groups.forEach((group, g) => {
    group.forEach((cat, k) => {
      if (index > 0) {
        const isBreak = k === 0;
        parts.push(`<button class="bsep ${isBreak ? "break" : "join"}" data-sep="${index - 1}" ${editable ? "" : "disabled"}
          title="${isBreak ? "Page break — click to put both in one group" : "Same group — click to add a page break"}">${isBreak ? "page break" : "no break"}</button>`);
      }
      parts.push(`<span class="bcat" data-cat="${cat}">
        <button data-move="${index}" data-dir="-1" aria-label="Move left" ${editable && index > 0 ? "" : "disabled"}>‹</button>
        ${BINDER_CATEGORIES[cat]} <small>${counts[cat]}</small>
        <button data-move="${index}" data-dir="1" aria-label="Move right" ${editable && index < order.length - 1 ? "" : "disabled"}>›</button>
      </span>`);
      index++;
    });
  });
  box.innerHTML = `<div class="bcats">${parts.join("")}</div>
    ${editable ? "" : `<p class="muted">Default order — pick a set to customise its binder layout.</p>`}`;
}

/** Applies an edit on the flat representation (category order + break positions), then saves. */
async function editBinder(fn) {
  const groups = binderGroups();
  const order = groups.flat();
  const breaks = new Set();
  let n = 0;
  for (const g of groups.slice(0, -1)) breaks.add((n += g.length) - 1); // break after index
  fn(order, breaks);
  const next = [[]];
  order.forEach((cat, i) => {
    next.at(-1).push(cat);
    if (breaks.has(i) && i < order.length - 1) next.push([]);
  });
  const set = state.set;
  state.binder = { ...state.binder, [set]: next };
  render();
  try {
    await api(`/api/binder/${encodeURIComponent(set)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groups: next }),
    });
  } catch (e) {
    toast(`Couldn't save binder layout: ${e.message}`);
  }
}

async function renderMissing() {
  const box = $("#missing");
  if (state.set === ALL) {
    box.innerHTML = `<p class="empty">Pick a set to see what's missing.</p>`;
    $("#stats").textContent = "";
    $("#dl-missing").removeAttribute("href");
    return;
  }
  const q = `set=${encodeURIComponent(state.set)}&mode=${state.mode}`;
  $("#dl-missing").href = `/api/missing?${q}&format=txt`;
  const { total, missing, cost, unpriced } = await api(`/api/missing?${q}`);
  $("#stats").innerHTML = `${missing.length} missing of ${total} ${state.mode === "foil" ? "foil treatments" : "cards"}` +
    ` · completion cost <strong>${eur(cost)}</strong>${unpriced ? ` <span class="muted">(+${unpriced} without price)</span>` : ""}`;
  if (!missing.length) return (box.innerHTML = `<p class="empty">Nothing missing — set complete! 🎉</p>`);
  const byType = Object.groupBy(missing, (m) => m.type);
  const sum = (list) => list.reduce((n, m) => n + (m.price ?? 0), 0);
  box.innerHTML = TYPES.filter((t) => byType[t])
    .map((t) => `<section class="missing-group"><h2>${t} <small>${byType[t].length} · ${eur(sum(byType[t]))}</small></h2><ul>${byType[t]
      .map((m) => `<li><button class="link" data-card="${esc(m.slug)}">${esc(m.card)}</button>
        <span class="muted">${esc(m.rarity ?? "")}${m.finish ? ` · ${esc(m.finish)}${m.product !== "Booster" ? ` (${esc(m.product)})` : ""}` : ""}</span>
        <a class="price" href="${cmLink(m.card)}" target="_blank" rel="noopener">${eur(m.price)}</a></li>`)
      .join("")}</ul></section>`)
    .join("");
}

function render() {
  const segKeys = { "#view": "view", "#elcount": "elCount", "#owned": "owned", "#mode": "mode", "#layout": "layout", "#quick": "quick" };
  for (const [seg, key] of Object.entries(segKeys)) {
    for (const b of $(seg).children) b.classList.toggle("on", b.dataset.v === state[key]);
  }
  for (const b of $("#types").children) b.classList.toggle("on", state.types.has(b.dataset.v));
  for (const b of $("#rarities").children) b.classList.toggle("on", state.rarities.has(b.dataset.v));
  for (const b of $("#elements").children) b.classList.toggle("on", state.elements.has(b.dataset.v));
  for (const b of $("#sets").children) b.classList.toggle("on", b.dataset.v === state.set);

  const cardsView = state.view === "cards";
  $("#card-filters").hidden = $("#card-layout").hidden = $(".min-price").hidden = !cardsView;
  const filtering = state.search || state.types.size || state.rarities.size || state.elements.size || state.elCount || state.owned;
  $("#clear-filters").disabled = !filtering;
  $("#grid").hidden = !cardsView || state.layout !== "grid";
  $("#binder").hidden = !cardsView || state.layout === "grid";
  $("#binder-config").hidden = $("#binder").hidden;
  // Binder order is fixed (groups, then alphabetical), so sorting only applies to the grid.
  $(".sort").hidden = state.layout !== "grid";
  $("#missing").hidden = $("#missing-filters").hidden = cardsView;
  if (cardsView) renderGrid();
  else renderMissing().catch((e) => toast(e.message));
}

// ---- detail dialog -----------------------------------------------------------

let detailCard = null;
let detailPrinting = null;

function openDetail(slug) {
  detailCard = state.cards.find((c) => c.slug === slug);
  detailPrinting = coverPrinting(printingsInScope(detailCard).length ? printingsInScope(detailCard) : detailCard.printings);
  renderDetail();
  $("#detail").showModal();
}

function renderDetail() {
  const c = detailCard;
  // Printings of the current set first, then the rest.
  const printings = [...c.printings].sort(
    (a, b) => (a.set === state.set ? 0 : 1) - (b.set === state.set ? 0 : 1) || state.sets.indexOf(a.set) - state.sets.indexOf(b.set),
  );
  $("#detail-body").innerHTML = `
    <img class="big" src="/img/${esc(detailPrinting.slug)}.png" alt="${esc(c.name)}">
    <div class="info">
      <h2>${elementDots(c)}${esc(c.name)}</h2>
      <p class="muted">${esc(c.type)}${c.subtypes.length ? ` — ${esc(c.subtypes.join(" "))}` : ""} · ${esc(c.rarity ?? "")}${c.cost != null ? ` · cost ${c.cost}` : ""}</p>
      ${c.rules ? `<p class="rules">${esc(c.rules)}</p>` : ""}
      <p><a href="${cmLink(c.name)}" target="_blank" rel="noopener">View on Cardmarket ↗</a></p>
      <table class="printings">
        <thead><tr><th>Set</th><th>Treatment</th><th>Price</th><th>Owned</th></tr></thead>
        <tbody>${printings.map((p) => {
          const q = state.collection[p.slug] ?? 0;
          return `<tr class="${p.slug === detailPrinting.slug ? "sel" : ""} ${q ? "has" : ""}" data-printing="${esc(p.slug)}">
            <td>${esc(p.set)}</td>
            <td>${FOILS.has(p.finish) ? "✦ " : ""}${esc(p.finish)}${p.product !== "Booster" ? ` <span class="muted">${esc(p.product)}</span>` : ""}</td>
            <td class="num">${eur(state.prices[p.slug])}</td>
            <td class="stepper"><button data-delta="-1" aria-label="Remove one" ${q ? "" : "disabled"}>−</button><span>${q}</span><button data-delta="1" aria-label="Add one">+</button></td>
          </tr>`;
        }).join("")}</tbody>
      </table>
    </div>`;
}

async function changeQuantity(slug, delta) {
  const quantity = Math.max(0, (state.collection[slug] ?? 0) + delta);
  try {
    await api(`/api/collection/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quantity }),
    });
  } catch (e) {
    return toast(`Couldn't save: ${e.message}`);
  }
  if (quantity) state.collection[slug] = quantity;
  else delete state.collection[slug];
  if ($("#detail").open) renderDetail();
  render();
}

// ---- events ------------------------------------------------------------------

function onSeg(sel, key, after) {
  $(sel).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    state[key] = b.dataset.v;
    after?.();
    render();
  });
}

function onChips(sel, set) {
  $(sel).addEventListener("click", (e) => {
    const b = e.target.closest("button[data-v]");
    if (!b) return;
    set.has(b.dataset.v) ? set.delete(b.dataset.v) : set.add(b.dataset.v);
    render();
  });
}

function bindEvents() {
  onSeg("#sets", "set", () => save("set", state.set));
  onSeg("#view", "view");
  onSeg("#elcount", "elCount");
  onSeg("#owned", "owned");
  onSeg("#mode", "mode");
  onSeg("#layout", "layout", () => save("layout", state.layout));
  onSeg("#quick", "quick", () => save("quick", state.quick));
  $("#binder-config").addEventListener("click", (e) => {
    const move = e.target.closest("[data-move]");
    if (move) {
      const i = Number(move.dataset.move);
      const j = i + Number(move.dataset.dir);
      // Swap categories; break positions stay put, so groups keep their shape.
      return editBinder((order) => ([order[i], order[j]] = [order[j], order[i]]));
    }
    const sep = e.target.closest("[data-sep]");
    if (sep) {
      const i = Number(sep.dataset.sep);
      editBinder((order, breaks) => (breaks.has(i) ? breaks.delete(i) : breaks.add(i)));
    }
  });
  $("#sort").value = state.sort;
  $("#sort").addEventListener("change", (e) => {
    state.sort = e.target.value;
    save("sort", state.sort);
    render();
  });
  onChips("#types", state.types);
  onChips("#rarities", state.rarities);
  onChips("#elements", state.elements);

  $("#min-price").value = state.minPrice || "";
  $("#min-price").addEventListener("input", (e) => {
    state.minPrice = Math.max(0, Number(e.target.value) || 0);
    save("minPrice", state.minPrice);
    render();
  });

  $("#clear-filters").addEventListener("click", () => {
    Object.assign(state, { search: "", elCount: "", owned: "" });
    for (const set of [state.types, state.rarities, state.elements]) set.clear();
    $("#search").value = "";
    render();
  });

  let debounce;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => ((state.search = e.target.value.trim()), render()), 150);
  });

  for (const sel of ["#grid", "#binder", "#missing"]) {
    $(sel).addEventListener("click", (e) => {
      const step = e.target.closest(".quick button[data-delta]");
      if (step) return changeQuantity(step.closest(".quick").dataset.printing, Number(step.dataset.delta));
      const t = e.target.closest("[data-card]");
      if (t) openDetail(t.dataset.card);
    });
  }

  $("#detail-body").addEventListener("click", (e) => {
    const row = e.target.closest("tr[data-printing]");
    if (!row) return;
    const step = e.target.closest("button[data-delta]");
    if (step) return changeQuantity(row.dataset.printing, Number(step.dataset.delta));
    detailPrinting = detailCard.printings.find((p) => p.slug === row.dataset.printing);
    renderDetail();
  });
  $("#detail").addEventListener("click", (e) => e.target === e.currentTarget && e.currentTarget.close());

  $("#import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !confirm(`Replace your whole collection with "${file.name}"?`)) return;
    try {
      const { imported, unmatched } = await api("/api/import", { method: "POST", body: await file.text() });
      state.collection = await api("/api/collection");
      toast(`Imported ${imported} printings${unmatched.length ? `, ${unmatched.length} rows not recognized` : ""}`);
      if (unmatched.length) console.warn("Unmatched rows", unmatched);
      render();
    } catch (err) {
      toast(`Import failed: ${err.message}`);
    }
  });

  bindSync();

  $("#copy-missing").addEventListener("click", async () => {
    const href = $("#dl-missing").getAttribute("href");
    if (!href) return;
    const text = await (await fetch(href)).text();
    await navigator.clipboard.writeText(text);
    toast("Missing list copied");
  });
}

// ---- Curiosa sync -------------------------------------------------------------

function showSyncPane(connected) {
  $("#sync-login").hidden = connected;
  $("#sync-main").hidden = !connected;
  $("#sync-result").innerHTML = "";
}

function renderChanges(changes) {
  if (!changes.length) return (($("#sync-result").innerHTML = `<p>Curiosa already matches your collection. ✓</p>`), undefined);
  const removals = changes.filter((c) => c.to === 0).length;
  $("#sync-result").innerHTML = `
    <p><strong>${changes.length}</strong> printings differ${removals ? ` — <strong>${removals}</strong> will be removed from Curiosa` : ""}.</p>
    <div class="changes"><table class="printings">
      <thead><tr><th>Card</th><th>Set</th><th>Treatment</th><th>Curiosa</th><th></th><th>Local</th></tr></thead>
      <tbody>${changes.map((c) => `<tr class="${c.to === 0 ? "removal" : ""}">
        <td>${esc(c.card)}</td><td>${esc(c.set)}</td>
        <td>${esc(c.finish)}${c.product !== "Booster" ? ` <span class="muted">${esc(c.product)}</span>` : ""}</td>
        <td class="num">${c.from}</td><td>→</td><td class="num">${c.to}</td></tr>`).join("")}</tbody>
    </table></div>
    <p><button id="sync-apply" class="btn primary">Update ${changes.length} printings on Curiosa</button></p>`;
}

function bindSync() {
  const busy = (btn, label) => ((btn.disabled = !!label), label && (btn.dataset.label ??= btn.textContent, btn.textContent = label));
  const idle = (btn) => ((btn.disabled = false), btn.dataset.label && (btn.textContent = btn.dataset.label));

  $("#sync").addEventListener("click", async () => {
    const { connected } = await api("/api/sync/session");
    showSyncPane(connected);
    $("#sync-dialog").showModal();
  });

  $("#save-cookie").addEventListener("click", async () => {
    try {
      await api("/api/sync/session", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: $("#cookie").value }),
      });
      $("#cookie").value = "";
      showSyncPane(true);
    } catch (e) {
      toast(e.message);
    }
  });

  $("#sync-logout").addEventListener("click", async () => {
    await api("/api/sync/session", { method: "DELETE" });
    showSyncPane(false);
  });

  $("#sync-preview").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    busy(btn, "Comparing…");
    try {
      renderChanges((await api("/api/sync/preview", { method: "POST" })).changes);
    } catch (err) {
      $("#sync-result").innerHTML = `<p class="error">${esc(err.message)}</p>`;
    } finally {
      idle(btn);
    }
  });

  $("#sync-result").addEventListener("click", async (e) => {
    const btn = e.target.closest("#sync-apply");
    if (!btn) return;
    busy(btn, "Updating Curiosa…");
    try {
      const { applied } = await api("/api/sync/apply", { method: "POST" });
      $("#sync-result").innerHTML = `<p>Updated ${applied} printings on Curiosa. ✓</p>`;
    } catch (err) {
      idle(btn);
      $("#sync-result").insertAdjacentHTML("beforeend", `<p class="error">${esc(err.message)} — safe to retry.</p>`);
    }
  });
}

async function init() {
  const [{ sets, cards }, collection, { prices }, binder] = await Promise.all([
    api("/api/cards"), api("/api/collection"), api("/api/prices"), api("/api/binder"),
  ]);
  Object.assign(state, { sets, cards, collection, prices, binder });
  if (state.set !== ALL && !sets.includes(state.set)) state.set = ALL;
  renderSets();
  renderChips();
  bindEvents();
  render();
}

init().catch((e) => toast(`Failed to load: ${e.message}`));
