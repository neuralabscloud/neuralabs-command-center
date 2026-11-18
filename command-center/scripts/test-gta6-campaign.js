// node scripts/test-gta6-campaign.js  (geen netwerk)
const g = require("../gta6-campaign");
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FOUT"}  ${m}`); if (!c) fails++; };
for (const price of [64115.43, 9999.5, 151234]) {
  g.ANGLES.forEach((a, i) => {
    const { text, card } = a.build(price);
    const e = g.validate(text);
    ok(!e.length, `${a.key} @ ${price}: ${e.join(", ") || [...text].length + " tekens"}`);
    ok(!g.validate(card.title + " " + card.kicker + " " + card.rows.flat().join(" ")).filter(x => !x.startsWith("te lang")).length, `${a.key} kaart copy`);
    ok(card.rows.length >= 2 && card.rows.length <= 5, `${a.key} rijen`);
  });
}
ok(g.angleFor("2026-11-18").key === "gta5_vs_now", "dag 1 = gta5_vs_now");
ok(g.angleFor("2026-11-19").key === "launch_day", "19 nov = launch day");
ok(g.angleFor("2026-11-27").key === "recap", "laatste dag recap");
ok(g.angleFor("2026-11-28") === null && g.angleFor("2026-11-17") === null, "buiten venster = null");
ok(g.validate("a — b").length && g.validate("HUGE news").length, "validator vangt streepje en caps");
ok(g.END === "2026-11-27", "END " + g.END);
const h = g.cardHtml({ kicker: "<x>", title: "t", rows: [["<a", "b"]], foot: "f" }, null);
ok(h.includes("&lt;x&gt;") && !h.includes("<x>") && h.includes("&lt;a"), "html escaped");
console.log(fails ? `${fails} FOUT` : "alles ok");
process.exit(fails ? 1 : 0);
