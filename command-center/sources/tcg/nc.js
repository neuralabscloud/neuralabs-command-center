// NeuraCollectibles API client (local, read only, server-side key in X-API-Key). The ONLY source of numbers
// on Slabhaus cards: pop counts, set index moves and release data, fetched in the same run with a timestamp.
const { getJson } = require("../http");

const DEFAULT_BASE = "http://127.0.0.1:8000/collectibles/v1";
const PUBLIC_URL = "https://api.neuralabs.cloud";
const latin = s => /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(String(s || ""));
const fmt = n => Number(n).toLocaleString("en-US");

function client({ base = DEFAULT_BASE, key } = {}) {
  const u = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("NC API alleen lokaal");
  return (p, q = {}) => {
    const url = new URL(`${base.replace(/\/$/, "")}/${p}`);
    for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
    return getJson(url.toString(), { allowHosts: [u.hostname], timeout: 15000, headers: key ? { "X-API-Key": key } : {} });
  };
}

// Pop per grade (6-10) for one grader, from analytics/cards/{id}/grading.
async function popFor(api, cardId, grader = "PSA") {
  const g = await api(`analytics/cards/${encodeURIComponent(cardId)}/grading`);
  const row = (g.graders || []).find(x => String(x.grade_company).toUpperCase() === grader) || null;
  if (!row || !row.population) return null;
  const pop = { grader };
  for (const k of ["6", "7", "8", "9", "10"]) if (Number.isFinite(Number(row.population[k]))) pop[k] = Number(row.population[k]);
  if (Number.isFinite(Number(row.population.total))) pop.total = Number(row.population.total);
  pop.as_of = row.population_as_of || null;
  if (Number.isFinite(row.gem_rate_pct)) pop.gem_rate_pct = row.gem_rate_pct;
  return Object.keys(pop).filter(k => /^\d+$/.test(k)).length >= 2 ? pop : null;
}

const cardLabel = c => `${c.name}${c.set_name ? ` (${c.set_name})` : ""}`;
function metric(o, fetchedAt) {
  return { kind: "metric", source: "NeuraCollectibles API", url: PUBLIC_URL, published_at: fetchedAt, data_fetched_at: fetchedAt, ...o };
}

// perStep: candidates per endpoint (the topic cooldown in news-cards.js then skips recently posted cards/sets).
// minSetMove: a set index move below this |%| is not news.
async function metricItems({ base, key, now = Date.now(), log = () => {}, perStep = 1, minSetMove = 0 } = {}) {
  if (!key) throw new Error("geen NC_API_KEY");
  const api = client({ base: base || DEFAULT_BASE, key });
  const at = new Date(now).toISOString();
  const out = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { log(`NC ${name}: ${e.message}`); } };

  await step("pop-shock", async () => {
    const r = await api("pop-shock", { language: "en", limit: 25 });
    const list = uniqCards((r.items || []).filter(x => x.card && latin(x.card.name) && latin(x.card.set_name) && x.psa10_now > x.psa10_then)).slice(0, perStep);
    for (const it of list) {
    const c = it.card;
    const pop = await popFor(api, c.card_id).catch(() => null);
    out.push(metric({
      id: `nc-popshock-${c.card_id}-${it.psa10_now}`,
      title: `PSA 10 population of ${cardLabel(c)} rose from ${fmt(it.psa10_then)} to ${fmt(it.psa10_now)} since ${it.since}`,
      summary: `NeuraCollectibles pop data as of ${it.as_of || r.as_of}: ${cardLabel(c)} (${c.language || "en"}) had ${fmt(it.psa10_then)} PSA 10 copies on ${it.since} and ${fmt(it.psa10_now)} now, a ${Math.round(it.growth_pct)}% increase.`,
      numbers: [{ raw: fmt(it.psa10_now), value: it.psa10_now }, { raw: fmt(it.psa10_then), value: it.psa10_then }, { raw: `${Math.round(it.growth_pct)}%`, value: it.growth_pct }],
      entities: [c.name, "pop", "psa"], pill_hint: "pop report", layouts: pop ? ["versus", "number", "persona", "signal"] : ["versus", "persona", "signal"],
      card: cardRef(c),
      versus: { left: { label: `PSA 10 pop on ${it.since}`, value: fmt(it.psa10_then), unit: "copies" }, right: { label: "PSA 10 pop now", value: fmt(it.psa10_now), unit: "copies" } },
      pop, nc_endpoint: "pop-shock",
    }, at));
    }
  });

  await step("grading leaders", async () => {
    const r = await api("analytics/grading/leaders", { language: "en", min_pop: 300, limit: 25 });
    const list = uniqCards((r.items || []).filter(x => x.card && latin(x.card.name) && latin(x.card.set_name) && x.pop10 > 0)).slice(0, perStep);
    for (const it of list) {
    const c = it.card;
    const pop = await popFor(api, c.card_id).catch(() => null);
    if (!pop) continue;
    out.push(metric({
      id: `nc-leader-${c.card_id}-${pop["10"]}`,
      title: `${cardLabel(c)} has ${fmt(pop["10"])} PSA 10 copies${pop.total ? ` out of ${fmt(pop.total)} graded` : ""}`,
      summary: `PSA population for ${cardLabel(c)} as of ${pop.as_of || it.pop_as_of}: ${["6", "7", "8", "9", "10"].filter(g => pop[g] != null).map(g => `PSA ${g}: ${fmt(pop[g])}`).join(", ")}.${pop.gem_rate_pct != null ? ` Gem rate ${pop.gem_rate_pct}%.` : ""}`,
      numbers: [{ raw: fmt(pop["10"]), value: pop["10"] }, ...(pop.total ? [{ raw: fmt(pop.total), value: pop.total }] : [])],
      entities: [c.name, "pop", "psa"], pill_hint: "pop report", layouts: ["number", "signal"], pop, nc_endpoint: "analytics/grading/leaders",
      card: cardRef(c),
    }, at));
    }
  });

  await step("releases", async () => {
    const r = await api("releases", { limit: 10 });
    const it = (r.items || []).find(x => x.is_new && x.language === "en" && latin(x.name));
    if (!it) return;
    const total = it.printed_total || it.total;
    out.push(metric({
      id: `nc-release-${it.set_id}`,
      title: `${it.name} released on ${it.release_date} with ${fmt(total)} cards in the main set`,
      summary: `${it.name} (${it.series || "Pokémon TCG"}, code ${it.code || "n/a"}) released on ${it.release_date}. Printed set size ${fmt(it.printed_total)}, ${fmt(it.total)} cards including secret rares.`,
      numbers: [{ raw: fmt(total), value: total }, ...(it.total !== total ? [{ raw: fmt(it.total), value: it.total }] : [])],
      entities: [it.name, "release", ...(/^[A-Z0-9]{2,6}$/.test(it.code || "") ? [it.code] : [])], pill_hint: "new set", layouts: ["signal", "number"], nc_endpoint: "releases",
    }, at));
  });

  await step("sets", async () => {
    const r = await api("analytics/sets", { limit: 50 });
    const sets = (r.items || []).filter(x => x.language === "en" && latin(x.name) && Number.isFinite(x.change_7d) && x.priced_cards >= 20 && Math.abs(x.change_7d) >= minSetMove);
    for (const it of sets.sort((a, b) => Math.abs(b.change_7d) - Math.abs(a.change_7d)).slice(0, perStep)) {
    const pct = Math.round(it.change_7d * 10) / 10;
    out.push(metric({
      id: `nc-set-${it.set_id}-${pct}`,
      title: `${it.name} set index moved ${pct > 0 ? "+" : ""}${pct}% over the last 7 days`,
      summary: `NeuraCollectibles set index for ${it.name} as of ${it.as_of || r.as_of}: ${pct > 0 ? "+" : ""}${pct}% in 7 days across ${fmt(it.priced_cards)} priced cards.`,
      numbers: [{ raw: `${pct}%`, value: pct }, { raw: fmt(it.priced_cards), value: it.priced_cards }],
      entities: [it.name, "market"], pill_hint: "market", layouts: ["signal", "persona"], nc_endpoint: "analytics/sets",
    }, at));
    }
  });
  return out;
}

// One entry per card name (pop-shock lists can hold several printings of the same card).
function uniqCards(list) { const seen = new Set(); return list.filter(x => { const k = String(x.card.name).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }

// Card identity on an item, for the image policy (tier 2: card image from the NC card database).
function cardRef(c) { return { card_id: c.card_id, name: c.name, set_name: c.set_name, number: c.number || null }; }

// Tier 2 lookup: the card's own scan from the NC card database (cards/{id}, else cards/search by name + set).
// Returns { image_url, source_page_url, card_id } or null. The image host is checked by images/policy.js.
async function cardImage({ base, key, card }) {
  if (!card || (!card.card_id && !card.name)) return null;
  const api = client({ base: base || DEFAULT_BASE, key });
  let c = null;
  if (card.card_id) c = await api(`cards/${encodeURIComponent(card.card_id)}`).catch(() => null);
  if (!c?.image_large_url && !c?.image_url && card.name) {
    const r = await api("cards/search", { q: card.name, language: "en", limit: 20 }).catch(() => null);
    const list = (r?.items || r?.data || r?.results || []).filter(x => (x.image_large_url || x.image_url) && String(x.name).toLowerCase() === String(card.name).toLowerCase());
    c = list.find(x => card.set_name && String(x.set_name).toLowerCase() === String(card.set_name).toLowerCase() && (!card.number || String(x.number) === String(card.number)))
      || list.find(x => card.set_name && String(x.set_name).toLowerCase() === String(card.set_name).toLowerCase()) || null;
  }
  const url = c && (c.image_large_url || c.image_url);
  return url ? { image_url: url, source_page_url: `${PUBLIC_URL}/collectibles/v1/cards/${encodeURIComponent(c.card_id)}`, card_id: c.card_id } : null;
}

module.exports = { DEFAULT_BASE, client, popFor, metricItems, cardImage, cardRef };
