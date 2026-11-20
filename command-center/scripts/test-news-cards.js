// node scripts/test-news-cards.js [--render <dir>]   (geen netwerk)
const nc = require("../news-cards");
let fails = 0;
const t = (name, cond) => { console.log(`${cond ? "ok  " : "FOUT"} ${name}`); if (!cond) fails++; };
const now = Date.parse("2026-11-16T07:30:00Z");

const item = { kind: "evergreen", source: "bitcoin.org", url: "https://bitcoin.org", title: "Block subsidy is 3.125 BTC since the April 2024 halving", summary: "The fourth halving cut the subsidy from 6.25 to 3.125 BTC per block at height 840,000.", numbers: [3.125, 6.25, 840000], entities: ["Bitcoin", "BTC"], layouts: ["number", "versus", "signal"] };
const good = {
  layout: "number", pill: "on-chain", headline: "[p]Bitcoin[/p] miners earn [a]3.125 BTC[/a] per block now", hint: "swipe for the breakdown",
  number: "3.125", unit: "BTC per block", series: [["2012", 25], ["2016", 12.5], ["2020", 6.25], ["2024", 3.125]], versus: null, context_line: "since the april 2024 halving",
  image_brief: null,
  payload: { title: "Why miners sell [a]anyway[/a]", items: [
    { title: "Subsidy halved", body: "The reward fell from 6.25 to 3.125 BTC at block 840,000." },
    { title: "Costs stay", body: "Power and hardware bills do not halve with the subsidy." },
    { title: "Fees fill gaps", body: "Transaction fees are the only other revenue for miners." }] },
  closer: { line: "Supply gets scarcer every four years", question: "Do you track miner flows?" },
  caption: "the block subsidy is 3.125 btc now\ndo you watch miner flows?\n#bitcoin #btc #mining #onchain",
  x_hook: "Bitcoin miners now earn 3.125 BTC per block. Here is why they sell anyway.",
  x_reply: "The subsidy fell from 6.25 to 3.125 BTC at block 840,000. Costs did not halve. Fees are the only other revenue. Source: bitcoin.org",
  source: { name: "bitcoin.org", url: "https://bitcoin.org", date: "2024-04-20" },
};

// highlight
t("highlight escapet html", nc.highlight("<b>[a]x[/a]") === '&lt;b&gt;<span class="hl-a">x</span>');
t("highlight [p]", nc.highlight("[p]BTC[/p] up").includes('<span class="hl-p">BTC</span>'));

// validator
let v = nc.validateCard(good, item);
t("geldige kaart ok " + v.errors.join("; "), v.ok);
const bad = (patch, re, name) => { const r = nc.validateCard({ ...good, ...patch }, item); t(name, !r.ok && r.errors.some(e => re.test(e))); };
bad({ headline: "Miners earn 3.125 BTC — still sell" }, /dash/, "em dash afgewezen");
bad({ headline: "Miners earn 3.125 BTC and it is HUGE" }, /CAPS/, "ALL CAPS afgewezen");
bad({ headline: "This insane 3.125 BTC reward" }, /superlatief/, "superlatief afgewezen");
bad({ headline: "Bitcoin will reach 3.125 BTC rewards" }, /predictie/, "will afgewezen");
bad({ headline: "[a]Bitcoin[/a] [a]miners[/a] earn 3.125 BTC" }, /\[a\]/, "twee [a] afgewezen");
bad({ headline: "Bitcoin miners earn 4.5 BTC per block now" }, /niet in payload/, "ongegrond headline-getal afgewezen");
bad({ headline: "Bitcoin miners earn a lot more than you think per block today ok" + " x".repeat(5) }, /> 70/, "headline > 70 afgewezen");
bad({ number: null }, /number layout/, "number zonder number afgewezen");
bad({ layout: "versus", versus: { left: { label: "2020", value: "6.25" } } }, /versus/, "versus met 1 kant afgewezen");
bad({ layout: "persona" }, /persona/, "persona zonder ik-vorm afgewezen");
bad({ headline: "I sold at 3.125 BTC per block" }, /eerste persoon/, "ik-vorm buiten persona afgewezen");
bad({ caption: "The reward\nquestion?\n#a #b #c #d" }, /lowercase/, "caption niet lowercase afgewezen");
bad({ caption: "x\ny?\n#a #b" }, /4 hashtags/, "caption hashtags afgewezen");
bad({ x_hook: "see neuralabs.cloud for 3.125" }, /NeuraLabs|link/, "link/NeuraLabs afgewezen");
bad({ payload: { ...good.payload, items: [{ title: "a", body: "Fees hit 912 BTC daily." }, good.payload.items[1], good.payload.items[2]] } }, /verzonnen/, "verzonnen getal in payload afgewezen");

// scoring
const fresh = { kind: "news", source: "coindesk", title: "Spot bitcoin ETF outflows hit $420 million", summary: "", published_at: "2026-11-16T05:00:00Z", numbers: [420], entities: ["ETF"] };
const s1 = nc.scoreItem(fresh, now);
t("vers nieuws scoort 100 " + JSON.stringify(s1), s1.total === 100 && !s1.reject);
t("oud nieuws afgewezen", !!nc.scoreItem({ ...fresh, published_at: "2026-11-14T05:00:00Z" }, now).reject);
t("zonder feit afgewezen", !!nc.scoreItem({ ...fresh, title: "Markets are moving", numbers: [] }, now).reject);
t("memecoin afgewezen", !!nc.scoreItem({ ...fresh, title: "New memecoin jumps 400%" }, now).reject);
t("evergreen freshness 40", nc.scoreItem(item, now).freshness === 40);

// dedup + plan
const hist = [{ dedup_key: nc.dedupKey(fresh), layout: "signal", created_at: "2026-11-10T07:30:00Z" }];
t("dedup binnen 30 dagen", nc.isDuplicate(fresh, hist, now));
const def = nc.layoutDeficits([{ layout: "signal", created_at: "2026-11-15T07:30:00Z" }, { layout: "signal", created_at: "2026-11-14T07:30:00Z" }, { layout: "signal", created_at: "2026-11-13T07:30:00Z" }], now);
t("deficit na 3x signal: number grootste tekort", def.signal < 0 && def.number > def.versus && def.number > 1);
const many = Array.from({ length: 21 }, (_, i) => ({ layout: ["signal", "signal", "signal", "number", "number", "versus", "persona"][i % 7], created_at: new Date(now - i * 7 * 3600e3).toISOString() }));
const d21 = nc.layoutDeficits(many, now);
t("mix 3/2/1/1 houdt bij 3 per dag", Math.max(...Object.values(d21)) - Math.min(...Object.values(d21)) < 1);
const plan = nc.planDay([fresh, item], [{ layout: "signal", created_at: "2026-11-15T07:30:00Z" }, { layout: "signal", created_at: "2026-11-14T07:30:00Z" }, { layout: "signal", created_at: "2026-11-13T07:30:00Z" }], { now, rand: () => 0.5 });
t("plan kiest number voor evergreen item", plan.length === 1 && plan[0].layout === "number" && plan[0].item === item);

// chart + slides
const svg = nc.chartSvg(good.series);
t("chart svg met pad", svg.startsWith("<svg") && svg.includes("<path"));
t("chart leeg bij 1 punt", nc.chartSvg([["a", 1]]) === "");
const slides = nc.buildSlides(good, {});
t("3 slides met closer", slides.length === 3 && slides[1].layout === "payload");
t("counter en dots", slides[1].html.includes("02 / 03") && (slides[1].html.match(/<i class="on">/g) || []).length === 1);
t("2 slides zonder closer", nc.buildSlides({ ...good, closer: null }, {}).length === 2);
t("geen script-injectie", !nc.buildSlides({ ...good, headline: "<script>x</script>" }, {})[0].html.includes("<script>x"));

// generateCard met nep-LLM: eerste poging fout, tweede goed
// Topic cooldown (scoring.topic_cooldown_days): same set/card/evergreen theme, other number = still a repeat.
{
  const m1 = { kind: "metric", title: "30th Celebration set index moved -19.6% over the last 7 days", numbers: [{ value: -19.6 }], entities: ["30th Celebration", "market"] };
  const m2 = { ...m1, title: "30th Celebration set index moved -9.1% over the last 7 days", numbers: [{ value: -9.1 }] };
  const m3 = { ...m1, title: "Perfect Order set index moved -12% over the last 7 days", numbers: [{ value: -12 }], entities: ["Perfect Order", "market"] };
  const ev1 = { kind: "evergreen", id: "base-set-holo-count", topic: "Base Set", title: "x", numbers: [16] };
  const ev2 = { kind: "evergreen", id: "base-red-cheeks", topic: "base set", title: "y", numbers: [58] };
  const pop = { kind: "metric", card: { name: "Fuecoco" }, entities: ["Fuecoco", "pop"], numbers: [{ value: 58 }] };
  t("topicKey set metric = set name", nc.topicKey(m1) === "30th celebration");
  t("topicKey evergreen = topic veld", nc.topicKey(ev1) === "base set" && nc.topicKey(ev2) === "base set");
  t("topicKey card = kaartnaam", nc.topicKey(pop) === "fuecoco");
  const hist = [{ created_at: new Date(now - 2 * 864e5).toISOString(), dedup_key: nc.dedupKey(m1), topic_key: nc.topicKey(m1) },
                { created_at: new Date(now - 3 * 864e5).toISOString(), dedup_key: nc.dedupKey(ev1), topic_key: nc.topicKey(ev1) }];
  t("zonder cooldown: ander getal is geen dubbel", !nc.isDuplicate(m2, hist, now));
  t("met cooldown 7d: zelfde set ander getal = dubbel", nc.isDuplicate(m2, hist, now, 30, 7));
  t("met cooldown 7d: andere set mag", !nc.isDuplicate(m3, hist, now, 30, 7));
  t("met cooldown 7d: ander Base Set-feit = dubbel", nc.isDuplicate(ev2, hist, now, 30, 7));
  t("na 7 dagen mag het onderwerp weer", !nc.isDuplicate(m2, hist, now + 6 * 864e5, 30, 7));
}

(async () => {
  let calls = 0;
  const llm = async (sys, user) => { calls++; return JSON.stringify(calls === 1 ? { ...good, headline: "Miners — sell" } : good); };
  const r = await nc.generateCard({ llm, item, layout: "number", pill: "on-chain" });
  t("generateCard regenereert na afwijzing", r.ok && calls === 2 && r.attempts[0].errors.length > 0);
  const r2 = await nc.generateCard({ llm: async () => "geen json", item, layout: "number" });
  t("generateCard geeft op na 3 pogingen", !r2.ok && r2.attempts.length === 3);

  const i = process.argv.indexOf("--render");
  if (i > 0) {
    const out = process.argv[i + 1];
    for (const layout of ["number", "signal", "versus", "persona"]) {
      const card = { ...good, layout, versus: { left: { label: "2020", value: "6.25", unit: "BTC" }, right: { label: "2024", value: "3.125", unit: "BTC" } }, headline: layout === "persona" ? "I stopped ignoring the [a]3.125 BTC[/a] subsidy" : good.headline };
      const files = await nc.renderSet(card, { setId: `test-${layout}`, outDir: out });
      t(`render ${layout} -> ${files.length} png`, files.length === 3);
    }
    await nc.closeBrowser();
  }
  console.log(fails ? `${fails} FOUT` : "alles ok");
  process.exit(fails ? 1 : 0);
})();
