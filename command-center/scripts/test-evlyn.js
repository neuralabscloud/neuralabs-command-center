// Tests voor evlyn.js (geen netwerk). Run: node scripts/test-evlyn.js
const ev = require("../evlyn");
const fs = require("fs"), os = require("os"), path = require("path");
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log("ok   " + name); } else { fail++; console.log("FOUT " + name); } };

// toegestane acties
check("restart app unit", ev.opAllowed("restart", "neuralabs-api.service"));
check("unit without suffix", ev.opAllowed("restart", "raydar-src-gdelt") && ev.normUnit("NC-Deals") === "nc-deals.service");
check("stop and start allowed", ev.opAllowed("stop", "slabhaus") && ev.opAllowed("start", "neuraintel"));
for (const u of ["nginx", "ssh", "sshd", "redis-server", "postgresql@16-main", "docker", "command-center", "nft-apps", "ufw", "systemd-logind", "neuradeck"])
  check(`no control over ${u}`, !ev.opAllowed("restart", u));
for (const a of ["enable", "disable", "mask", "kill", "edit", "daemon-reload", "", undefined])
  check(`action ${a} refused`, !ev.opAllowed(a, "neuralabs-api"));
for (const u of ["neuralabs-api.service; rm -rf /", "../nginx.service", "nc-deals.service nginx.service", "nc-deals.timer", "-H root@x nc-deals", "", null, "nc-deals.service\nnginx.service"])
  check(`odd unit refused: ${JSON.stringify(u)}`, !ev.opAllowed("restart", u));
check("core units readable, not controllable", ev.canInspect("nginx") && !ev.canControl("nginx"));
check("unknown unit not readable", !ev.canInspect("ssh") && !ev.canInspect("systemd-journald"));

// systemctl-uitvoer
const units = ev.parseUnits("nginx.service loaded active running A web server\nnc-deals.service loaded failed failed NC deals\nssh.service loaded active running OpenSSH\n\n");
check("parseUnits filters", units.length === 2 && units[1].unit === "nc-deals.service" && units[1].active === "failed" && units[1].controllable && !units[0].controllable);
const show = ev.parseShow("ActiveState=active\nSubState=running\nNRestarts=2\nDescription=a=b\n");
check("parseShow", show.ActiveState === "active" && show.NRestarts === "2" && show.Description === "a=b");

// bevestiging
const p = ev.createPending(1000);
const id = p.add({ action: "restart", unit: "nc-deals.service" }, 0);
check("pending id is random hex", /^[a-f0-9]{12}$/.test(id));
check("pending unknown id", p.take("nope", 10) === null);
check("pending taken once", p.take(id, 10).unit === "nc-deals.service" && p.take(id, 20) === null);
const id2 = p.add({ x: 1 }, 0);
check("pending expires", p.take(id2, 5000) === null);

// afbeeldingen
const pad = b => Buffer.concat([b, Buffer.alloc(16)]);
check("png", ev.sniffImage(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) === "image/png");
check("jpeg", ev.sniffImage(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))) === "image/jpeg");
check("gif", ev.sniffImage(pad(Buffer.from("GIF89a"))) === "image/gif");
check("webp", ev.sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)])) === "image/webp");
check("svg refused", ev.sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>")) === null);
check("html, pdf, empty refused", ev.sniffImage(Buffer.from("<!doctype html><html></html>")) === null && ev.sniffImage(pad(Buffer.from("%PDF-1.7"))) === null && ev.sniffImage(Buffer.alloc(0)) === null && ev.sniffImage("x") === null);
const name = ev.newMediaName();
check("media name", ev.validMediaName(name) && !ev.validMediaName("../" + name) && !ev.validMediaName("a.jpg") && !ev.validMediaName(name + "/x") && !ev.validMediaName(undefined));

// gespreksverloop
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evlyn-test-"));
const file = path.join(dir, "sub", "chat.json");
const st = ev.createStore(file, 5);
const a = st.add({ role: "user", source: "telegram", text: "hoi", images: [name, "../evil.jpg"], voice: true });
const b = st.add({ role: "assistant", source: "web", text: "hallo" });
check("store ids ascend", a.id === 1 && b.id === 2 && st.cursor() === 2);
check("store keeps valid images only", a.images.length === 1 && a.images[0] === name && a.voice === true);
check("store roles and sources", a.source === "telegram" && b.role === "assistant" && st.add({ role: "x", source: "y", text: 1 }).role === "user");
check("since", st.since(1).length === 2 && st.since(0).length === 3 && st.since(99).length === 0);
const card = st.add({ role: "system", text: "", action: { id: "abc", status: "pending" } });
const cur = st.cursor();
st.patch(card.id, m => { m.action.status = "done"; });
check("patched card shows up again", st.since(cur).length === 1 && st.since(cur)[0].action.status === "done");
check("patch unknown id", st.patch(999, () => {}) === null);
check("store persists", ev.createStore(file, 5).since(0).length === 4);
for (let i = 0; i < 10; i++) st.add({ role: "user", text: "m" + i });
check("store capped", st.since(0).length === 5);
st.clear();
check("clear empties and moves the cursor", st.since(0).length === 0 && st.cursor() > cur);
check("long text cut", st.add({ role: "user", text: "x".repeat(30000) }).text.length === 20000);
fs.rmSync(dir, { recursive: true, force: true });

// oude afbeeldingen uit de geschiedenis
const hist = [];
for (let i = 0; i < 8; i++) hist.push({ role: i % 2 ? "assistant" : "user", content: i % 2 ? "ok" : [{ type: "image", source: {} }, { type: "text", text: "t" + i }] });
ev.pruneImages(hist, 6);
check("old images replaced", hist[0].content[0].type === "text" && hist[0].content[1].text === "t0");
check("recent images kept", hist[2].content[0].type === "image" && hist[6].content[0].type === "image");

// tekst in stukken
const chunks = ev.chunkText("a".repeat(3000) + "\n" + "b".repeat(3000), 4000);
check("chunk splits on newline", chunks.length === 2 && chunks[0] === "a".repeat(3000) && chunks[1] === "b".repeat(3000));
check("chunk hard split", ev.chunkText("c".repeat(9000), 4000).every(c => c.length <= 4000) && ev.chunkText("c".repeat(9000), 4000).join("").length === 9000);
check("chunk empty", ev.chunkText("").length === 0);

// rem
const lim = ev.createLimiter(2, 1000);
check("limiter", lim(0) && lim(1) && !lim(2) && lim(1500));

console.log(`\n${pass} ok, ${fail} FOUT`);
process.exit(fail ? 1 : 0);
