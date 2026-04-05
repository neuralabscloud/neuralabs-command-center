'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const pty       = require('node-pty');
const fs        = require('fs');
const path      = require('path');
const chokidar  = require('chokidar');
const https     = require('https');

// ─── Prevent duplicate server processes ──────────────────
const LOCK_FILE = path.join(__dirname, '.server.lock');
function acquireLock() {
  try {
    // Check if lock exists and process is still alive
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
      try {
        process.kill(oldPid, 0); // test if process exists
        console.error(`[SERVER] Another instance already running (PID ${oldPid}). Exiting.`);
        process.exit(1);
      } catch {
        // Old process is dead — stale lock, safe to overwrite
        console.log(`[SERVER] Removing stale lock (PID ${oldPid} is dead).`);
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (err) {
    console.error(`[SERVER] Lock error: ${err.message}`);
    process.exit(1);
  }
}
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}
acquireLock();
process.on('exit', releaseLock);
process.on('SIGINT',  () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
// ─────────────────────────────────────────────────────────

const { execSync } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ── AUTH (shared session with Command Center) ──
function parseCookies(req) {
  const c = {};
  (req.headers.cookie || '').split(';').forEach(p => { const [k, ...v] = p.trim().split('='); if (k) c[k] = v.join('='); });
  return c;
}

async function checkAuth(req) {
  const token = parseCookies(req).cc_session;
  if (!token) return false;
  try {
    const r = await fetch('http://localhost:3004/auth/check', { headers: { Cookie: `cc_session=${token}` } });
    const data = await r.json();
    return data.authenticated === true;
  } catch { return false; }
}

// Login redirect page
app.get('/login', (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login</title>
<style>body{background:#000;color:#f0f0f0;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px}.box h2{font-size:14px;color:#888;margin-bottom:16px}
a{color:hsl(264 65% 60%);text-decoration:none;font-size:13px;border:1px solid hsl(264 65% 40%);padding:10px 24px;border-radius:8px;display:inline-block}
a:hover{background:hsla(264 65% 49%/0.1)}</style></head>
<body><div class="box"><h2>Authentication required</h2><a href="http://${_req.headers.host?.replace(':3000',':3003')}/login.html">Login via Command Center</a></div></body></html>`);
});

// Protect all routes except /api/status (needed by command center internally)
app.use(async (req, res, next) => {
  // Allow /api/status from localhost (command center worker)
  if (req.path === '/api/status') {
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
    // External requests need auth
    if (await checkAuth(req)) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.path === '/login') return next();
  if (await checkAuth(req)) return next();
  res.redirect('/login');
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/status', (_req, res) => res.json(getSnapshot()));

// ─── Process-based bot alive check ──────────────────────
const BOT_CWD_MAP = {};
for (const bot of CONFIG.bots) {
  if (bot.workdir) BOT_CWD_MAP[bot.id] = bot.workdir;
}

function checkBotProcesses() {
  const result = {};
  for (const botId of Object.keys(BOT_CWD_MAP)) result[botId] = false;
  try {
    // Get all python PIDs and check their cwd symlink
    const pids = execSync("ls /proc | grep -E '^[0-9]+$'", { encoding: 'utf8', timeout: 3000 }).trim().split('\n');
    for (const pid of pids) {
      let cmdline, cwd;
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      } catch { continue; }
      if (!cmdline.includes('python')) continue;
      for (const [botId, botCwd] of Object.entries(BOT_CWD_MAP)) {
        if (cwd === botCwd) { result[botId] = true; break; }
      }
    }
  } catch {}
  return result;
}

let botProcessAlive = checkBotProcesses();
setInterval(() => {
  botProcessAlive = checkBotProcesses();
  broadcast('process_status', botProcessAlive);
}, 10_000);

// ─── State ───────────────────────────────────────────────
const orderbooks  = {};
const mids        = {};
const clients     = new Set();
const ptySessions = new Map();
const botStates   = {};

for (const bot of CONFIG.bots) {
  botStates[bot.id] = buildEmptyState(bot);
}

let hlTradesBuffer = [];

// ─── Helpers ─────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, data }));
}

// ─── Process health check ─────────────────────────────────
const LOG_STALE_MS = 10 * 60 * 1000; // 10 min — log older than this = not running

function isBotProcessRunning(bot) {
  if (!bot.script || !bot.workdir) return null; // no config, skip check
  try {
    const pids = execSync(`pgrep -f "${bot.script}"`, { encoding: 'utf8', timeout: 3000 }).trim().split('\n');
    for (const pid of pids) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid.trim()}/cwd`);
        if (path.resolve(cwd) === path.resolve(bot.workdir)) return true;
      } catch { /* pid gone or no permission */ }
    }
    return false;
  } catch { return false; } // pgrep returns exit 1 when no match
}

function isLogFresh(logPath) {
  try {
    const stat = fs.statSync(logPath);
    return (Date.now() - stat.mtimeMs) < LOG_STALE_MS;
  } catch { return false; }
}

function checkBotHealth() {
  for (const bot of CONFIG.bots) {
    if (!bot.enabled || !botStates[bot.id]) continue;
    const processRunning = isBotProcessRunning(bot);
    const logFresh = isLogFresh(bot.logFile);
    // Bot is truly online only if process runs AND log is fresh
    const alive = processRunning === true && logFresh;
    botStates[bot.id].online = alive;
    botStates[bot.id].processRunning = processRunning;
    botStates[bot.id].logFresh = logFresh;
  }
}

function buildEmptyState(bot) {
  return {
    id:     bot ? bot.id   : 'bot',
    name:   bot ? bot.name : 'Bot',
    type:   bot ? bot.type : 'funding',
    online: false,
    lastSeen: null,
    positions: [],
    accountValue: 0,
    totalNtl: 0,
    stats: { dailyPnl: 0, dailyFunding: 0, totalPnl: 0, totalFunding: 0, winRate: 0, totalTrades: 0, openOrders: 0, drawdown: 0, tradesToday: 0 },
    fundingRates: {},
    inventory: [],
    recentActivity: [],
    recentLogs: [],
    trades: [],
  };
}

// ─── Read only the tail of a log file (last N bytes) ─────
function readTailLines(filePath, maxBytes = 128 * 1024) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    // If we truncated, drop the first partial line
    if (start > 0 && lines.length > 0) lines.shift();
    return lines;
  } finally { fs.closeSync(fd); }
}

// ─── Funding bot log parser ───────────────────────────────
function parseBotLog(logPath) {
  const lines = readTailLines(logPath, 256 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  const sepIdx = [];
  for (let i = lines.length - 1; i >= 0 && sepIdx.length < 3; i--) {
    if (lines[i].includes('-------') && (sepIdx.length === 0 || sepIdx[0] - i > 1)) sepIdx.unshift(i);
  }

  const blockLines = sepIdx.length >= 2
    ? lines.slice(sepIdx[sepIdx.length - 2] + 1, sepIdx[sepIdx.length - 1])
    : [];

  const activePosFromBlock = {};

  for (const line of blockLines) {
    // Delta-neutraal formaat: [OPEN delta-neutraal] PnL: $X (perp: $X | spot: $X | funding: $X)
    const posMatchDN = line.match(/(\w+)\s+([-+\d.]+)%\s+ann\.\s+\[OPEN\s+delta-neutraal\]\s+PnL:\s*\$([-+\d.]+)\s+\(perp:\s*\$([-+\d.]+)\s*\|\s*spot:\s*\$([-+\d.]+)\s*\|\s*funding:\s*\$([-+\d.]+)\)/i);
    if (posMatchDN) {
      const asset = posMatchDN[1].toUpperCase();
      activePosFromBlock[asset] = {
        asset,
        side:             'DELTA-NEUTRAAL',
        fundingRate:      parseFloat(posMatchDN[2]),
        unrealizedPnl:    parseFloat(posMatchDN[3]),
        perpPnl:          parseFloat(posMatchDN[4]),
        spotPnl:          parseFloat(posMatchDN[5]),
        fundingCollected: parseFloat(posMatchDN[6]),
      };
    }

    // Oud formaat (backwards compat): [OPEN LONG/SHORT] PnL: $X (funding: $X)
    const posMatch = line.match(/(\w+)\s+([-+\d.]+)%\s+ann\.\s+\[OPEN\s+(LONG|SHORT)\]\s+PnL:\s*\$([-+\d.]+)\s+\(funding:\s*\$([-+\d.]+)\)/i);
    if (posMatch) {
      const asset = posMatch[1].toUpperCase();
      activePosFromBlock[asset] = {
        asset,
        side:             posMatch[3].toUpperCase(),
        fundingRate:      parseFloat(posMatch[2]),
        unrealizedPnl:    parseFloat(posMatch[4]),
        fundingCollected: parseFloat(posMatch[5]),
      };
    }

    const rateMatch = line.match(/^\s+(\w+)\s+([-+\d.]+)%\s+ann\.\s*$/);
    if (rateMatch) {
      state.fundingRates[rateMatch[1].toUpperCase()] = parseFloat(rateMatch[2]);
    }

    const pnlMatch = line.match(/Dag PnL.*?\:\s*\$([-+\d.]+)\s*\|\s*Funding:\s*\$([-+\d.]+)/i);
    if (pnlMatch) {
      state.stats.dailyPnl     = parseFloat(pnlMatch[1]);
      state.stats.dailyFunding = parseFloat(pnlMatch[2]);
    }
  }

  const lastOpen   = {};
  const lastClosed = {};

  for (const line of lines) {
    const closeMatch = line.match(/Positie gesloten:\s*(\w+)\s*\|/i);
    if (closeMatch) {
      const asset = closeMatch[1].toUpperCase();
      const ts = parseLogTimestamp(line);
      if (!lastClosed[asset] || ts > lastClosed[asset]) lastClosed[asset] = ts;
    }

    // Delta-neutraal open formaat: "Positie geopend: DELTA-NEUTRAAL BTC | Perp SHORT @ $X | Spot LONG @ $Y | Funding: Z% ann."
    const openMatchDN = line.match(/Positie geopend:\s*DELTA-NEUTRAAL\s+(\w+)\s*\|.*Perp SHORT @ \$([\d,. ]+)\s*\|.*Spot LONG @ \$([\d,. ]+)\s*\|.*Funding:\s*([-+\d.]+)%/i);
    if (openMatchDN) {
      const asset = openMatchDN[1].toUpperCase();
      const ts    = parseLogTimestamp(line);
      if (!lastOpen[asset] || ts > lastOpen[asset].ts) {
        lastOpen[asset] = {
          ts,
          side:           'DELTA-NEUTRAAL',
          entryPrice:     parseFloat(openMatchDN[2].replace(/[, ]/g, '')),
          spotEntryPrice: parseFloat(openMatchDN[3].replace(/[, ]/g, '')),
          fundingAtOpen:  parseFloat(openMatchDN[4]),
          openedAt:       extractTime(line),
        };
      }
    }

    // Oud formaat (backwards compat)
    const openMatch = line.match(/Positie geopend:\s*(LONG|SHORT)\s+(\w+)\s*@\s*\$([\d,. ]+)\s*\|.*Funding:\s*([-+\d.]+)%/i);
    if (openMatch) {
      const asset = openMatch[2].toUpperCase();
      const ts    = parseLogTimestamp(line);
      if (!lastOpen[asset] || ts > lastOpen[asset].ts) {
        lastOpen[asset] = {
          ts,
          side:          openMatch[1].toUpperCase(),
          entryPrice:    parseFloat(openMatch[3].replace(/[, ]/g, '')),
          fundingAtOpen: parseFloat(openMatch[4]),
          openedAt:      extractTime(line),
        };
      }
    }
  }

  for (const [asset, pos] of Object.entries(activePosFromBlock)) {
    const openInfo  = lastOpen[asset];
    const closeTime = lastClosed[asset] || 0;
    if (openInfo && openInfo.ts > closeTime) {
      state.positions.push({
        ...pos,
        entryPrice:    openInfo.entryPrice,
        fundingAtOpen: openInfo.fundingAtOpen,
        openedAt:      openInfo.openedAt,
        openedTs:      openInfo.ts,
      });
    } else {
      state.positions.push({
        ...pos,
        entryPrice:    openInfo ? openInfo.entryPrice : null,
        fundingAtOpen: openInfo ? openInfo.fundingAtOpen : null,
        openedAt:      openInfo ? openInfo.openedAt : null,
        openedTs:      openInfo ? openInfo.ts : 0,
      });
    }
  }

  const activityPatterns = [
    /Positie geopend/i,
    /Positie gesloten/i,
    /Opportuniteit/i,
    /Kill switch/i,
    /ERROR/i,
    /FUNDING RATES/i,
    /% ann\./i,
    /Dag PnL/i,
    /Skip \w+:/i,
    /---+/,
  ];
  const recentActivity = [];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 30; i--) {
    if (activityPatterns.some(p => p.test(lines[i]))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  return state;
}

// ─── Market maker bot log parser ─────────────────────────
function parseMmBotLog(logPath) {
  const lines = readTailLines(logPath, 128 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  // Find last status block between "-------" separators (skip duplicate adjacent separators)
  const sepIdx = [];
  for (let i = lines.length - 1; i >= 0 && sepIdx.length < 3; i--) {
    if (lines[i].includes('-------') && (sepIdx.length === 0 || sepIdx[0] - i > 1)) sepIdx.unshift(i);
  }

  const blockLines = sepIdx.length >= 2
    ? lines.slice(sepIdx[sepIdx.length - 2] + 1, sepIdx[sepIdx.length - 1])
    : [];

  let totalOpenOrders = 0;
  const inventory = [];

  for (const line of blockLines) {
    // "  BTC    Mid: $ 68,637.00 | Inventaris: LONG $247.49 | Open orders: 2"
    const assetMatch = line.match(/(\w+)\s+Mid:\s*\$\s*([\d,. ]+)\s*\|\s*Inventaris:\s*(\w+)\s*\$([-\d.]+)\s*\|\s*Open orders:\s*(\d+)/i);
    if (assetMatch) {
      const orders = parseInt(assetMatch[5], 10);
      totalOpenOrders += orders;
      const invSide   = assetMatch[3].toUpperCase();
      const invAmount = parseFloat(assetMatch[4]);
      inventory.push({
        asset:      assetMatch[1].toUpperCase(),
        midPrice:   parseFloat(assetMatch[2].replace(/[, ]/g, '')),
        side:       invSide,
        amount:     invSide === 'SHORT' ? -invAmount : invAmount,
        openOrders: orders,
      });
    }

    // "Dag PnL: $+0.0000 | Trades vandaag: 62 | Drawdown: 0.34%"
    const pnlMatch = line.match(/Dag PnL:\s*\$([-+\d.]+)\s*\|\s*Trades vandaag:\s*(\d+)\s*\|\s*Drawdown:\s*([\d.]+)%/i);
    if (pnlMatch) {
      state.stats.dailyPnl    = parseFloat(pnlMatch[1]);
      state.stats.tradesToday = parseInt(pnlMatch[2], 10);
      state.stats.drawdown    = parseFloat(pnlMatch[3]);
    }
  }

  state.stats.openOrders = totalOpenOrders;
  state.inventory = inventory;

  const activityPatterns = [
    /Bid geplaatst/i,
    /Ask geplaatst/i,
    /Positie al open/i,
    /Stop-Loss/i,
    /Inventaris alert/i,
    /Kill switch/i,
    /ERROR/i,
  ];
  const activityExclude = [
    /draait al \(PID/i,
    /Stale lockfile/i,
  ];
  const recentActivity = [];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 15; i--) {
    if (activityPatterns.some(p => p.test(lines[i])) && !activityExclude.some(p => p.test(lines[i]))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  return state;
}

// ─── Polymarket Sniper log parser ────────────────────
function parsePolyBotLog(logPath) {
  const lines = readTailLines(logPath, 128 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  // Collect relevant activity lines
  const activityKeywords = ['RISK', 'SCANNER', 'SNIPER', 'AUTOPILOT', 'FOUND', 'WOULD BUY', 'Order',
    'TRIGGER', 'ARB_EXEC', 'ARB_DETECTOR', 'BAYES', 'KELLY', 'Koop', 'gevuld', 'COPY', 'STINK',
    'HEDGE', 'TIMEZONE', 'Directional', 'FILLED', 'WIN', 'LOSS', 'settlement'];
  const recentActivity = [];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 20; i--) {
    if (activityKeywords.some(kw => lines[i].includes(kw))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  // Parse balance from "[RISK] CLOB saldo: $98.90 USDC"
  let balance = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\[RISK\].*CLOB saldo:\s*\$([\d.]+)\s*USDC/i);
    if (m) { balance = parseFloat(m[1]); break; }
  }
  state.polyBalance = balance;

  // Parse last [RISK ENGINE] status block
  let tradesTotal = 0, realizedPnl = 0, polyWins = 0, polyLosses = 0;
  let polyPeakBalance = null, polyDrawdown = null, polyConsecLosses = 0, polyStartingBalance = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('[RISK ENGINE]') || lines[i].includes('RISK ENGINE')) {
      const blockEnd = Math.min(i + 20, lines.length);
      for (let j = i; j < blockEnd; j++) {
        const trM = lines[j].match(/Trades today:\s*(\d+)\s*\(W:(\d+)\s+L:(\d+)\)/i);
        if (trM) { tradesTotal = parseInt(trM[1], 10); polyWins = parseInt(trM[2], 10); polyLosses = parseInt(trM[3], 10); }
        const pnlM = lines[j].match(/Realized PnL:\s*[+$]*([-+\d.]+)\s*USDC/i);
        if (pnlM) realizedPnl = parseFloat(pnlM[1]);
        const pkM = lines[j].match(/Peak balance:\s*\$([\d.]+)/i);
        if (pkM) polyPeakBalance = parseFloat(pkM[1]);
        const ddM = lines[j].match(/Drawdown:\s*\$([\d.]+)/i);
        if (ddM) polyDrawdown = parseFloat(ddM[1]);
        const clM = lines[j].match(/Consec\.\s*losses:\s*(\d+)/i);
        if (clM) polyConsecLosses = parseInt(clM[1], 10);
        const sbM = lines[j].match(/Starting balance:\s*\$([\d.]+)/i);
        if (sbM) polyStartingBalance = parseFloat(sbM[1]);
      }
      break;
    }
  }
  state.polyTradesToday     = tradesTotal;
  state.polyRealizedPnl     = realizedPnl;
  state.polyWins            = polyWins;
  state.polyLosses          = polyLosses;
  state.polyPeakBalance     = polyPeakBalance;
  state.polyDrawdown        = polyDrawdown;
  state.polyConsecLosses    = polyConsecLosses;
  state.polyStartingBalance = polyStartingBalance;

  // Last scanner/detector status line
  let polyScannerWindow = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const wm = lines[i].match(/\[SCANNER-\w+\]\s*(.*)/i)
            || lines[i].match(/\[ARB_DETECTOR\]\s*(.*markten.*)/i)
            || lines[i].match(/\[ARB_DETECTOR\].*TRIGGER:\s*(.*)/i)
            || lines[i].match(/\[TIMEZONE\]\s*(.*edge.*|.*execute.*)/i);
    if (wm) { polyScannerWindow = wm[1].trim(); break; }
  }
  state.polyScannerWindow = polyScannerWindow;

  // Last scan result: last [SCANNER] or [AUTOPILOT] line
  let lastScan = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\[SCANNER\]|\[AUTOPILOT\]/i.test(lines[i])) { lastScan = lines[i]; break; }
  }
  state.polyLastScan = lastScan;

  // Last fired order: any actual order activity
  let lastOrder = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/DRY RUN.*WOULD BUY|Firing FOK order|Order response|Koop \d+x|Order gevuld|order.*matched|FILLED|ARB_EXEC.*Directional/i.test(lines[i])) { lastOrder = lines[i]; break; }
  }
  state.polyLastOrder = lastOrder;

  // Dry run detection: check log AND session state file
  let polyDryRun = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/DRY RUN(?! *=)/i.test(lines[i]))             { polyDryRun = true;  break; }
    if (/LIVE TRADING|LIVE MODE/i.test(lines[i]))      { polyDryRun = false; break; }
    if (/dry_run=True/i.test(lines[i]))                { polyDryRun = true;  break; }
    if (/dry_run=False/i.test(lines[i]))               { polyDryRun = false; break; }
  }
  // Fallback: check process command line for --live flag
  if (polyDryRun === null) {
    try {
      const pids = require('child_process').execSync("pgrep -f autopilot", { encoding: 'utf8', timeout: 2000 }).trim().split('\n');
      for (const pid of pids) {
        try {
          const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmdline.includes('--live')) { polyDryRun = false; break; }
        } catch {}
      }
    } catch {}
  }
  if (polyDryRun === null) polyDryRun = true; // safe default
  state.polyDryRun = polyDryRun;

  // Also surface stats for totals bar compatibility
  state.stats.dailyPnl = realizedPnl;

  return state;
}

// ─── Polymarket session state parser ─────────────────
function parsePolySessionState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const s   = JSON.parse(raw);

    // On-chain sync data
    const syncPath = statePath.replace('session_state.json', 'sync_trades.json');
    let syncData = null;
    try { syncData = JSON.parse(fs.readFileSync(syncPath, 'utf8')); } catch {}

    // Open positions
    const posPath = statePath.replace('session_state.json', 'open_positions.json');
    let openPositions = [];
    try { openPositions = JSON.parse(fs.readFileSync(posPath, 'utf8')) || []; } catch {}

    // Calculate real open positions from on-chain data (buys - sells - redeems)
    const ocBuySize = {};
    const ocSellSize = {};
    for (const t of (syncData?.trades || [])) {
      if (t.side === 'BUY') ocBuySize[t.market] = (ocBuySize[t.market] || 0) + (t.size || 0);
      if (t.side === 'SELL') ocSellSize[t.market] = (ocSellSize[t.market] || 0) + (t.size || 0);
    }
    for (const r of (syncData?.redeems || [])) {
      ocSellSize[r.market] = (ocSellSize[r.market] || 0) + 99999; // redeem closes all
    }
    let ocOpenCount = 0;
    for (const m of Object.keys(ocBuySize)) {
      if ((ocBuySize[m] || 0) - (ocSellSize[m] || 0) > 0.01) ocOpenCount++;
    }

    // On-chain trades (BUY + SELL + REDEEM) sorted newest first
    const allOnchain = [];
    if (syncData) {
      for (const t of (syncData.trades || [])) {
        allOnchain.push({ time: t.time, market: t.market, title: t.title, side: t.side, outcome: t.outcome, size: t.size, usdc: t.usdc, price: t.price, source: 'chain' });
      }
      for (const r of (syncData.redeems || [])) {
        allOnchain.push({ time: r.time, market: r.market, title: r.title, side: 'REDEEM', size: 0, usdc: r.usdc, price: 1.0, source: 'chain' });
      }
    }
    allOnchain.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    // Compute completed trades with P/L (sell vs avg buy, redeem vs cost)
    const buysByMarket = {};
    for (const t of (syncData?.trades || [])) {
      if (t.side === 'BUY') {
        if (!buysByMarket[t.market]) buysByMarket[t.market] = [];
        buysByMarket[t.market].push(t);
      }
    }
    const completedTrades = [];
    for (const t of (syncData?.trades || [])) {
      if (t.side !== 'SELL') continue;
      const buys = buysByMarket[t.market] || [];
      if (!buys.length) continue;
      const avgBuy = buys.reduce((s, b) => s + b.usdc, 0) / Math.max(1, buys.reduce((s, b) => s + b.size, 0));
      const pnl = (t.price - avgBuy) * t.size;
      completedTrades.push({ time: t.time, title: t.title, type: 'SELL', pnl: Math.round(pnl * 100) / 100, size: t.size, price: t.price });
    }
    for (const r of (syncData?.redeems || [])) {
      const buys = buysByMarket[r.market] || [];
      const cost = buys.reduce((s, b) => s + b.usdc, 0);
      const pnl = r.usdc - cost;
      completedTrades.push({ time: r.time, title: r.title, type: 'REDEEM', pnl: Math.round(pnl * 100) / 100, size: r.usdc, price: 1.0 });
    }
    completedTrades.sort((a, b) => (b.time || '').localeCompare(a.time || ''));

    const ocWins = completedTrades.filter(t => t.pnl > 0).length;
    const ocLosses = completedTrades.filter(t => t.pnl < 0).length;
    const ocRealizedPnl = completedTrades.reduce((s, t) => s + t.pnl, 0);
    const ocWinrate = (ocWins + ocLosses) > 0 ? Math.round(ocWins / (ocWins + ocLosses) * 1000) / 10 : 0;

    const syncSummary = syncData?.summary || {};

    // MACD stats
    const macdPrimary = s.macd_primary_signals_today || 0;
    const macdDouble = s.macd_double_confirmed_today || 0;
    const macdFiltered = s.macd_filtered_today || 0;
    const macdAvgKelly = s.avg_kelly_multiplier || 0;

    return {
      startingBalance: s.starting_balance || 0,
      peakBalance:     s.peak_balance     || 0,
      realizedPnl:     s.realized_pnl     || 0,
      tradesToday:     Math.max(s.trades_today || 0, syncSummary.total_trades || 0),
      wins:            s.wins_today       || 0,
      losses:          s.losses_today     || 0,
      consecLosses:    s.consecutive_losses || 0,
      consecWins:      s.consecutive_wins || 0,
      totalProfit:     s.total_profit     || 0,
      tradeLog:        allOnchain.slice(0, 40),
      completedTrades: completedTrades.slice(0, 20),
      ocOpenCount,
      onchainPnl:      syncSummary.net_pnl || 0,
      onchainTrades:   syncSummary.total_trades || 0,
      onchainRedeems:  syncSummary.total_redeems || 0,
      onchainBought:   syncSummary.total_bought || 0,
      onchainSold:     syncSummary.total_sold || 0,
      onchainRedeemed: syncSummary.total_redeemed || 0,
      ocWins, ocLosses, ocRealizedPnl, ocWinrate,
      macdPrimary, macdDouble, macdFiltered, macdAvgKelly,
    };
  } catch { return null; }
}

// ─── Liquidation bot log parser ──────────────────────
function parseLiqBotLog(logPath) {
  const lines = readTailLines(logPath, 512 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  // Find last status block between "------" separators (skip duplicate adjacent separators)
  const sepIdx = [];
  for (let i = lines.length - 1; i >= 0 && sepIdx.length < 3; i--) {
    if (lines[i].includes('------') && (sepIdx.length === 0 || sepIdx[0] - i > 1)) sepIdx.unshift(i);
  }

  const blockLines = sepIdx.length >= 2
    ? lines.slice(sepIdx[sepIdx.length - 2] + 1, sepIdx[sepIdx.length - 1])
    : [];

  for (const line of blockLines) {
    // Old format: "  LONG ETH    @ $  2,131.75  SL: $  2,089.12  TP: $  2,344.93  PnL: $+12.50  [BREAKOUT]"
    // LCMR format: "  LONG ETH @ $  2,131.75 | PnL: $+12.50 (+0.6%) | VWAP: $2,095.00 TP1=HIT"
    const posMatchOld = line.match(/(LONG|SHORT)\s+(\w+)\s+@\s*\$([\d,.]+)(?:\s+SL:\s*\$([\d,.]+))?(?:\s+TP:\s*\$([\d,.]+))?\s+PnL:\s*\$([-+\d.]+)\s+\[(\w+)\]/i);
    const posMatchLCMR = line.match(/(LONG|SHORT)\s+(\w+)\s+@\s*\$([\d,.]+)\s*\|\s*PnL:\s*\$([-+\d.]+)\s*\(([+-][\d.]+)%\)\s*\|\s*VWAP:\s*\$([\d,.]+)/i);
    if (posMatchOld) {
      state.positions.push({
        asset:         posMatchOld[2].toUpperCase(),
        side:          posMatchOld[1].toUpperCase(),
        entryPrice:    parseFloat(posMatchOld[3].replace(/,/g, '')),
        unrealizedPnl: parseFloat(posMatchOld[6]),
        signalType:    posMatchOld[7],
        fundingCollected: 0,
        totalPnl:      parseFloat(posMatchOld[6]),
        positionValue: 0,
        returnOnEquity: 0,
        leverage: 1,
        liquidationPx: null,
        stopLoss:      posMatchOld[4] ? parseFloat(posMatchOld[4].replace(/,/g, '')) : null,
        takeProfit:    posMatchOld[5] ? parseFloat(posMatchOld[5].replace(/,/g, '')) : null,
      });
    } else if (posMatchLCMR) {
      state.positions.push({
        asset:         posMatchLCMR[2].toUpperCase(),
        side:          posMatchLCMR[1].toUpperCase(),
        entryPrice:    parseFloat(posMatchLCMR[3].replace(/,/g, '')),
        unrealizedPnl: parseFloat(posMatchLCMR[4]),
        signalType:    'LCMR',
        fundingCollected: 0,
        totalPnl:      parseFloat(posMatchLCMR[4]),
        positionValue: 0,
        returnOnEquity: 0,
        leverage: 1,
        liquidationPx: null,
        stopLoss:      null,
        takeProfit:    null,
        vwapTarget:    parseFloat(posMatchLCMR[6].replace(/,/g, '')),
        pnlPct:        parseFloat(posMatchLCMR[5]),
      });
    }

    // "Dag PnL: $+8.40 | Trades: 2 | Drawdown: 0.50%"
    const pnlMatch = line.match(/Dag PnL:\s*\$([-+\d.]+)\s*\|\s*Trades:\s*(\d+)\s*\|\s*Drawdown:\s*([\d.]+)%/i);
    if (pnlMatch) {
      state.stats.dailyPnl    = parseFloat(pnlMatch[1]);
      state.stats.tradesToday = parseInt(pnlMatch[2], 10);
      state.stats.drawdown    = parseFloat(pnlMatch[3]);
    }
  }

  const activityPatterns = [
    /Positie geopend/i,
    /Positie gesloten/i,
    /SIGNAAL:/i,
    /Kill switch/i,
    /ERROR/i,
    /Trailing stop.*->/i,
    /cascade gedetecteerd/i,
    /Jarvis/i,
    /\[FUNDING\]/,
    /Trend filter/i,
    /SCAN -/i,
    /Zones:\s*\d+/i,
    /Geen actieve signalen/i,
    /signaal geblokkeerd/i,
    /Verliesreeks/i,
  ];
  const recentActivity = [];
  const activityExclude = [
    /---+/,
    /Datasource actief/i,
  ];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 15; i--) {
    if (activityPatterns.some(p => p.test(lines[i])) && !activityExclude.some(p => p.test(lines[i]))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  return state;
}

// ─── CVD + Liquidation Confluence bot log parser ─────
function parseCvdBotLog(logPath) {
  const lines = readTailLines(logPath, 128 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  // Find last status block containing OPEN positions between "------" separators
  const sepIdx = [];
  for (let i = lines.length - 1; i >= 0 && sepIdx.length < 6; i--) {
    if (lines[i].includes('------')) sepIdx.unshift(i);
  }

  let blockLines = [];
  for (let s = sepIdx.length - 1; s >= 1; s--) {
    const candidate = lines.slice(sepIdx[s - 1] + 1, sepIdx[s]);
    if (candidate.some(l => /OPEN\s+(LONG|SHORT)/i.test(l) || /Dag PnL/i.test(l))) {
      blockLines = candidate;
      break;
    }
  }

  for (const line of blockLines) {
    // "  OPEN LONG BTC  @ $94975.00  PnL: $+2.10  [CVD]"
    const posMatch = line.match(/OPEN\s+(LONG|SHORT)\s+(\w+)\s+@\s*\$([\d,.]+)\s+PnL:\s*\$([-+\d.]+)\s+\[(\w+)\]/i);
    if (posMatch) {
      state.positions.push({
        asset:         posMatch[2].toUpperCase(),
        side:          posMatch[1].toUpperCase(),
        entryPrice:    parseFloat(posMatch[3].replace(/,/g, '')),
        unrealizedPnl: parseFloat(posMatch[4]),
        signalType:    posMatch[5],
        fundingCollected: 0,
        totalPnl:      parseFloat(posMatch[4]),
        positionValue: 0,
        returnOnEquity: 0,
        leverage: 1,
        liquidationPx: null,
      });
    }

    // "Dag PnL: $+8.40 | Trades: 2 | Drawdown: 0.50%"
    const pnlMatch = line.match(/Dag PnL:\s*\$([-+\d.]+)\s*\|\s*Trades:\s*(\d+)\s*\|\s*Drawdown:\s*([\d.]+)%/i);
    if (pnlMatch) {
      state.stats.dailyPnl    = parseFloat(pnlMatch[1]);
      state.stats.tradesToday = parseInt(pnlMatch[2], 10);
      state.stats.drawdown    = parseFloat(pnlMatch[3]);
    }
  }

  // CVD-specific metrics from scan lines
  const cvdScores = {};
  const liqClusters = {};
  for (let i = lines.length - 1; i >= 0 && Object.keys(cvdScores).length < 3; i--) {
    // "BTC | price=$94975.00 | CVD=65.20% | liq=YES short"
    const scanMatch = lines[i].match(/(\w+)\s*\|\s*price=\$([\d,.]+)\s*\|\s*CVD=([\d.]+)%\s*\|\s*liq=(\w+)/i);
    if (scanMatch) {
      const sym = scanMatch[1].toUpperCase();
      if (!cvdScores[sym]) {
        cvdScores[sym] = parseFloat(scanMatch[3]);
        liqClusters[sym] = scanMatch[4] !== 'none' ? scanMatch[4] : null;
      }
    }
  }
  state.cvdScores   = cvdScores;
  state.liqClusters = liqClusters;

  // Recent activity
  const activityPatterns = [
    /Positie geopend/i,
    /Positie gesloten/i,
    /SIGNAAL/i,
    /SIGNAL/i,
    /Kill switch/i,
    /ERROR/i,
    /Scan cycle/i,
    /CVD=\d/i,
  ];
  const recentActivity = [];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 15; i--) {
    if (activityPatterns.some(p => p.test(lines[i]))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  return state;
}

// ─── Mean-Reversion Bot log parser ──────────────────
function parseTrendBotLog(logPath) {
  const lines = readTailLines(logPath, 128 * 1024);
  if (!lines) return null;
  const state = buildEmptyState(null);
  state.online   = true;
  state.lastSeen = new Date().toISOString();
  state.recentLogs = lines.slice(-80);

  // Find last status block between "------" separators
  const sepIdx = [];
  for (let i = lines.length - 1; i >= 0 && sepIdx.length < 3; i--) {
    if (lines[i].includes('------') && (sepIdx.length === 0 || sepIdx[0] - i > 1)) sepIdx.unshift(i);
  }

  const blockLines = sepIdx.length >= 2
    ? lines.slice(sepIdx[sepIdx.length - 2] + 1, sepIdx[sepIdx.length - 1])
    : [];

  const trendData = {};

  for (const line of blockLines) {
    // "BTC   BB: $67721.61 / $68346.20 / $68970.79 | RSI: 46.9 | ADX: 16.0 | Prijs: $68137.00"
    const bbMatch = line.match(/(\w+)\s+BB:\s*\$([\d,.]+)\s*\/\s*\$([\d,.]+)\s*\/\s*\$([\d,.]+)\s*\|\s*RSI:\s*([\d.]+)\s*\|\s*ADX:\s*([\d.]+)\s*\|\s*Prijs:\s*\$([\d,.]+)/i);
    if (bbMatch) {
      const adxVal = parseFloat(bbMatch[6]);
      trendData[bbMatch[1].toUpperCase()] = {
        bbLower:   parseFloat(bbMatch[2].replace(/,/g, '')),
        bbMiddle:  parseFloat(bbMatch[3].replace(/,/g, '')),
        bbUpper:   parseFloat(bbMatch[4].replace(/,/g, '')),
        rsi:       parseFloat(bbMatch[5]),
        adx:       adxVal,
        price:     parseFloat(bbMatch[7].replace(/,/g, '')),
        marketType: adxVal < 25 ? 'RANGE' : 'TRENDING',
      };
      continue;
    }

    // "BTC   BB-breedte: 1.83% | Afstand UB: 1.22% | Afstand LB: 0.61%"
    const bwMatch = line.match(/(\w+)\s+BB-breedte:\s*([\d.]+)%\s*\|\s*Afstand UB:\s*([\d.]+)%\s*\|\s*Afstand LB:\s*([\d.]+)%/i);
    if (bwMatch) {
      const coin = bwMatch[1].toUpperCase();
      if (trendData[coin]) {
        trendData[coin].bbWidth   = parseFloat(bwMatch[2]);
        trendData[coin].distUpper = parseFloat(bwMatch[3]);
        trendData[coin].distLower = parseFloat(bwMatch[4]);
      }
      continue;
    }

    // "POSITIE: LONG BTC @ $70883.00 | PnL: $+1.50 | TP: $71946.00 | SL: $70351.00"
    const posMatch = line.match(/POSITIE:\s*(LONG|SHORT)\s+(\w+)\s+@\s*\$([\d,.]+)\s*\|\s*PnL:\s*\$([-+\d.]+)(?:\s*\|\s*TP:\s*\$([\d,.]+))?(?:\s*\|\s*SL:\s*\$([\d,.]+))?/i);
    if (posMatch) {
      state.positions.push({
        asset:         posMatch[2].toUpperCase(),
        side:          posMatch[1].toUpperCase(),
        entryPrice:    parseFloat(posMatch[3].replace(/,/g, '')),
        unrealizedPnl: parseFloat(posMatch[4]),
        signalType:    'MR',
        fundingCollected: 0,
        totalPnl:      parseFloat(posMatch[4]),
        positionValue: 0,
        returnOnEquity: 0,
        leverage: 5,
        liquidationPx: null,
        takeProfit:    posMatch[5] ? parseFloat(posMatch[5].replace(/,/g, '')) : null,
        stopLoss:      posMatch[6] ? parseFloat(posMatch[6].replace(/,/g, '')) : null,
      });
    }

    // "BB midden target: $68346.20"
    const bbTargetMatch = line.match(/BB midden target:\s*\$([\d,.]+)/i);
    if (bbTargetMatch && state.positions.length > 0) {
      state.positions[state.positions.length - 1].bbMiddle = parseFloat(bbTargetMatch[1].replace(/,/g, ''));
    }

    // "Dag PnL: $+5.20 | Trades: 2/8 | WR: 50% | Balans: $44.86 | Kill: UIT"
    const pnlMatch = line.match(/Dag PnL:\s*\$([-+\d.]+)\s*\|\s*Trades:\s*(\d+)\/(\d+)\s*\|\s*WR:\s*([\d.]+)%\s*\|\s*Balans:\s*\$([\d.]+)/i);
    if (pnlMatch) {
      state.stats.dailyPnl    = parseFloat(pnlMatch[1]);
      state.stats.tradesToday = parseInt(pnlMatch[2], 10);
      state.stats.winRate     = parseFloat(pnlMatch[4]);
      state.stats.drawdown    = 0;
    }
  }

  state.trendData = trendData;

  // Enrich positions with size from "POSITIE GEOPEND" lines
  const openSizes = {};
  for (const line of lines) {
    const openMatch = line.match(/POSITIE GEOPEND:\s*(LONG|SHORT)\s+(\w+)\s+@.*\|\s*Size:\s*\$([\d,.]+)/i);
    if (openMatch) {
      openSizes[openMatch[2].toUpperCase()] = parseFloat(openMatch[3].replace(/,/g, ''));
    }
  }
  for (const pos of state.positions) {
    if (openSizes[pos.asset]) {
      pos.positionValue = openSizes[pos.asset];
    }
  }

  // Bereken winrate uit trade history file
  try {
    const bot = CONFIG.bots.find(b => b.type === 'trend');
    if (bot && bot.dataFile && fs.existsSync(bot.dataFile)) {
      const trades = JSON.parse(fs.readFileSync(bot.dataFile, 'utf8'));
      if (Array.isArray(trades) && trades.length > 0) {
        const wins = trades.filter(t => (t.total_pnl ?? t.pnl_usd ?? t.pnl ?? 0) > 0).length;
        state.stats.winRate = Math.round(wins / trades.length * 100);
        state.stats.totalTrades = trades.length;
        state.trades = trades.slice(-20).reverse();
      }
    }
  } catch (e) { /* ignore */ }

  // Recent activity
  const activityPatterns = [
    /SIGNAAL\s+(LONG|SHORT)/i,
    /POSITIE GEOPEND/i,
    /POSITIE GESLOTEN/i,
    /Trailing stop/i,
    /Stop-Loss/i,
    /Take-Profit/i,
    /BB midden bereikt/i,
    /Max houdtijd/i,
    /Kill switch/i,
    /MR signaal/i,
    /Orphaned positie/i,
    /ERROR/i,
  ];
  const recentActivity = [];
  for (let i = lines.length - 1; i >= 0 && recentActivity.length < 15; i--) {
    if (activityPatterns.some(p => p.test(lines[i]))) recentActivity.unshift(lines[i]);
  }
  state.recentActivity = recentActivity;

  return state;
}

function parseLogTimestamp(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (!m) return 0;
  return new Date(m[1].replace(' ', 'T')).getTime();
}

function extractTime(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function parseMmTradeHistory(dataPath) {
  try {
    const raw   = fs.readFileSync(dataPath, 'utf8');
    const fills = JSON.parse(raw);
    const arr   = Array.isArray(fills) ? fills : [];
    return { trades: arr.slice(-50).reverse(), totalTrades: arr.length };
  } catch { return null; }
}

function parseTradeHistory(dataPath) {
  try {
    const raw    = fs.readFileSync(dataPath, 'utf8');
    const trades = JSON.parse(raw);
    const arr    = Array.isArray(trades) ? trades : (trades.trades || []);
    const getPnl = t => t.total_pnl ?? t.pnl_usd ?? t.pnl ?? 0;
    const totalPnl     = arr.reduce((s, t) => s + getPnl(t), 0);
    const totalFunding = arr.reduce((s, t) => s + (t.funding_collected || 0), 0);
    const wins         = arr.filter(t => getPnl(t) > 0).length;
    const winRate      = arr.length ? Math.round(wins / arr.length * 100) : 0;

    // Daily PnL from trade_history (source of truth) — use Europe/Amsterdam timezone
    const TZ = 'Europe/Amsterdam';
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    const todayTrades = arr.filter(t => {
      const dt = t.dt || t.closed_at || '';
      if (!dt) return false;
      const dLocal = new Date(dt).toLocaleDateString('sv-SE', { timeZone: TZ });
      return dLocal === todayStr;
    });
    const dailyPnl     = todayTrades.reduce((s, t) => s + getPnl(t), 0);
    const tradesToday   = todayTrades.length;
    const dailyWins     = todayTrades.filter(t => getPnl(t) > 0).length;
    const dailyWinRate  = tradesToday ? Math.round(dailyWins / tradesToday * 100) : 0;

    return { trades: arr.slice(-30).reverse(), totalPnl, totalFunding, winRate, totalTrades: arr.length, dailyPnl, tradesToday, dailyWinRate };
  } catch { return null; }
}

function getSnapshot() { return botStates; }

// ─── Bot watchers ─────────────────────────────────────────
function setupBotWatchers() {
  for (const bot of CONFIG.bots) {
    if (!bot.enabled) continue;

    const refreshAll = () => {
      const logState   = bot.type === 'trend' ? parseTrendBotLog(bot.logFile)
                       : bot.type === 'poly' ? parsePolyBotLog(bot.logFile)
                       : parseBotLog(bot.logFile);
      const tradeStats = (bot.type === 'poly') ? (bot.stateFile ? parsePolySessionState(bot.stateFile) : null)
                       : parseTradeHistory(bot.dataFile);

      if (logState) {
        // online is now managed by checkBotHealth() — don't override here
        botStates[bot.id].lastSeen       = logState.lastSeen;
        botStates[bot.id].recentLogs     = logState.recentLogs;
        botStates[bot.id].recentActivity = logState.recentActivity;
        botStates[bot.id].stats.dailyPnl     = logState.stats.dailyPnl;
        botStates[bot.id].stats.dailyFunding = logState.stats.dailyFunding;
        botStates[bot.id].stats.openOrders   = logState.stats.openOrders;
        botStates[bot.id].stats.drawdown     = logState.stats.drawdown;
        botStates[bot.id].stats.tradesToday  = logState.stats.tradesToday;

        if (bot.type === 'funding') {
          botStates[bot.id].fundingRates = logState.fundingRates;
          for (const pos of (botStates[bot.id].positions || [])) {
            const rate = logState.fundingRates?.[pos.asset];
            if (rate != null) pos.fundingRate = rate;
          }
        // liq: positions come from pollBotPositions (live API)
        } else if (bot.type === 'trend') {
          // Trend bot: merge log-parsed positions into existing (don't overwrite live PnL)
          if (logState.positions && logState.positions.length > 0) {
            const existing = botStates[bot.id].positions || [];
            if (existing.length > 0) {
              // Merge log fields into existing positions (preserve live PnL/currentPx from API poller)
              for (const logPos of logState.positions) {
                const ex = existing.find(e => e.asset === logPos.asset && e.side === logPos.side);
                if (ex) {
                  ex.takeProfit    = logPos.takeProfit    ?? ex.takeProfit;
                  ex.stopLoss      = logPos.stopLoss      ?? ex.stopLoss;
                  ex.bbMiddle      = logPos.bbMiddle      ?? ex.bbMiddle;
                  ex.positionValue = logPos.positionValue  || ex.positionValue;
                  ex.signalType    = logPos.signalType     || ex.signalType;
                  ex.entryPrice    = logPos.entryPrice     || ex.entryPrice;
                } else {
                  // New position not yet in existing array — add it with log data
                  existing.push(logPos);
                }
              }
              // Remove positions that are no longer in the log
              botStates[bot.id].positions = existing.filter(ex =>
                logState.positions.some(lp => lp.asset === ex.asset && lp.side === ex.side)
              );
            } else {
              // No existing positions — use log-parsed ones directly
              botStates[bot.id].positions = logState.positions;
            }
          } else if (logState.positions && logState.positions.length === 0) {
            botStates[bot.id].positions = [];
          }
          botStates[bot.id].trendData = logState.trendData || {};
        } else if (bot.type === 'poly') {
          botStates[bot.id].polyBalance         = logState.polyBalance;
          botStates[bot.id].polyTradesToday     = logState.polyTradesToday;
          botStates[bot.id].polyRealizedPnl     = logState.polyRealizedPnl;
          botStates[bot.id].polyLastScan        = logState.polyLastScan;
          botStates[bot.id].polyLastOrder       = logState.polyLastOrder;
          botStates[bot.id].polyDryRun          = logState.polyDryRun;
          botStates[bot.id].polyWins            = logState.polyWins;
          botStates[bot.id].polyLosses          = logState.polyLosses;
          botStates[bot.id].polyPeakBalance     = logState.polyPeakBalance;
          botStates[bot.id].polyDrawdown        = logState.polyDrawdown;
          botStates[bot.id].polyConsecLosses    = logState.polyConsecLosses;
          botStates[bot.id].polyStartingBalance = logState.polyStartingBalance;
          botStates[bot.id].polyScannerWindow   = logState.polyScannerWindow;
        }
      }

      if (tradeStats) {
        if (bot.type === 'poly') {
          // Session state + on-chain sync merged data
          botStates[bot.id].polyRealizedPnl     = tradeStats.realizedPnl;
          botStates[bot.id].polyTradesToday     = tradeStats.tradesToday;
          botStates[bot.id].polyWins            = tradeStats.wins;
          botStates[bot.id].polyLosses          = tradeStats.losses;
          botStates[bot.id].polyConsecLosses    = tradeStats.consecLosses;
          botStates[bot.id].polyConsecWins      = tradeStats.consecWins || 0;
          botStates[bot.id].polyPeakBalance     = tradeStats.peakBalance   || botStates[bot.id].polyPeakBalance;
          botStates[bot.id].polyStartingBalance = tradeStats.startingBalance || botStates[bot.id].polyStartingBalance;
          botStates[bot.id].polyTradeLog        = tradeStats.tradeLog;
          botStates[bot.id].polyCompletedTrades = tradeStats.completedTrades || [];
          botStates[bot.id].polyOcOpenCount     = tradeStats.ocOpenCount || 0;
          botStates[bot.id].polyOnchainPnl      = tradeStats.onchainPnl    || 0;
          botStates[bot.id].polyOnchainTrades   = tradeStats.onchainTrades || 0;
          botStates[bot.id].polyOnchainRedeems  = tradeStats.onchainRedeems|| 0;
          botStates[bot.id].polyOnchainBought   = tradeStats.onchainBought || 0;
          botStates[bot.id].polyOnchainSold     = tradeStats.onchainSold   || 0;
          botStates[bot.id].polyOnchainRedeemed = tradeStats.onchainRedeemed|| 0;
          botStates[bot.id].polyOcWins          = tradeStats.ocWins || 0;
          botStates[bot.id].polyOcLosses        = tradeStats.ocLosses || 0;
          botStates[bot.id].polyOcRealizedPnl   = tradeStats.ocRealizedPnl || 0;
          botStates[bot.id].polyOcWinrate       = tradeStats.ocWinrate || 0;
          botStates[bot.id].polyMacdPrimary     = tradeStats.macdPrimary || 0;
          botStates[bot.id].polyMacdDouble      = tradeStats.macdDouble || 0;
          botStates[bot.id].polyMacdFiltered    = tradeStats.macdFiltered || 0;
          botStates[bot.id].polyMacdAvgKelly    = tradeStats.macdAvgKelly || 0;
          botStates[bot.id].stats.dailyPnl      = tradeStats.onchainPnl || tradeStats.realizedPnl;
        } else {
          botStates[bot.id].trades            = tradeStats.trades;
          botStates[bot.id].stats.totalTrades = tradeStats.totalTrades;
          botStates[bot.id].stats.totalPnl     = tradeStats.totalPnl;
          botStates[bot.id].stats.winRate       = tradeStats.winRate;
          // Daily PnL from trade_history (source of truth, overrides log parsing)
          botStates[bot.id].stats.dailyPnl     = tradeStats.dailyPnl;
          botStates[bot.id].stats.tradesToday   = tradeStats.tradesToday;
          if (bot.type === 'funding') {
            botStates[bot.id].stats.totalFunding  = tradeStats.totalFunding;
          }
        }
      }

      broadcast('bot_update', { botId: bot.id, state: botStates[bot.id] });
    };

    refreshAll();

    const watchOpts = { persistent: false, usePolling: true, interval: 2000 };
    if (bot.logFile)   chokidar.watch(bot.logFile,   watchOpts).on('change', refreshAll).on('add', refreshAll);
    if (bot.dataFile)  chokidar.watch(bot.dataFile,  watchOpts).on('change', refreshAll).on('add', refreshAll);
    if (bot.stateFile) chokidar.watch(bot.stateFile, watchOpts).on('change', refreshAll).on('add', refreshAll);
    // Also watch on-chain sync file and open positions for poly bot
    if (bot.stateFile && bot.type === 'poly') {
      const syncFile = bot.stateFile.replace('session_state.json', 'sync_trades.json');
      const posFile  = bot.stateFile.replace('session_state.json', 'open_positions.json');
      chokidar.watch(syncFile, watchOpts).on('change', refreshAll).on('add', refreshAll);
      chokidar.watch(posFile,  watchOpts).on('change', refreshAll).on('add', refreshAll);
    }
    setInterval(refreshAll, 10_000);
  }
}

// ─── HL positions poller ──────────────────────────────────
function hlPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(CONFIG.hyperliquid_rest);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function hlPostUrl(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? require('https') : require('http');
    const req  = mod.request({
      hostname: u.hostname, path: u.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function pollBotPositions(bot) {
  const walletAddress = bot.wallet_address;
  if (!walletAddress) return;

  const restUrl = bot.api_rest || CONFIG.hyperliquid_rest;

  try {
    const state = await hlPostUrl(restUrl, { type: 'clearinghouseState', user: walletAddress });

    let accountValue   = parseFloat(state.marginSummary?.accountValue || 0);
    const totalNtl     = parseFloat(state.marginSummary?.totalNtlPos || 0);

    const positions = (state.assetPositions || []).map(({ position: p }) => {
      const szi     = parseFloat(p.szi);
      const side    = szi < 0 ? 'SHORT' : 'LONG';
      const upnl    = parseFloat(p.unrealizedPnl || 0);
      const funding = parseFloat(p.cumFunding?.sinceOpen || 0);
      const fundingCollected = -funding;
      const posVal  = parseFloat(p.positionValue || 0);
      const currentPx = szi !== 0 ? posVal / Math.abs(szi) : 0;
      return {
        asset:            p.coin,
        side,
        szi:              Math.abs(szi),
        entryPrice:       parseFloat(p.entryPx || 0),
        currentPx,
        positionValue:    posVal,
        unrealizedPnl:    upnl,
        fundingCollected,
        totalPnl:         upnl + fundingCollected,
        liquidationPx:    p.liquidationPx ? parseFloat(p.liquidationPx) : null,
        marginUsed:       parseFloat(p.marginUsed || 0),
        leverage:         p.leverage?.value || 1,
        returnOnEquity:   parseFloat(p.returnOnEquity || 0),
        fundingRate:      botStates[bot.id].fundingRates?.[p.coin] || null,
        openedAt:         null,
        openedTs:         0,
      };
    });

    // Enrich with log data (funding bot only)
    if (bot.type === 'funding') {
      for (const pos of positions) {
        const logPos = botStates[bot.id].positions?.find(lp => lp.asset === pos.asset);
        if (logPos) {
          pos.fundingRate = logPos.fundingRate ?? pos.fundingRate;
          pos.openedAt    = logPos.openedAt;
          pos.openedTs    = logPos.openedTs || 0;
        }
      }
    }

    // Unified account: Hyperliquid shows spot USDC as the account total
    if (bot.unified_account) {
      try {
        const spotState = await hlPostUrl(restUrl, { type: 'spotClearinghouseState', user: walletAddress });
        const spotUsdc  = (spotState.balances || []).find(b => b.coin === 'USDC');
        if (spotUsdc) accountValue = parseFloat(spotUsdc.total || 0);
      } catch (e) { console.error(`[${bot.id}] spot fetch error:`, e.message); }
    }

    // Trend bot: log is bron van waarheid voor welke posities van de bot zijn.
    // API levert live prijzen/PnL, maar wallet kan ook niet-bot posities bevatten.
    if (bot.type === 'trend') {
      const logPositions = botStates[bot.id].positions || [];
      if (logPositions.length > 0) {
        // Enrich log-parsed positions met live API data
        for (const logPos of logPositions) {
          const apiPos = positions.find(p => p.asset === logPos.asset && p.side === logPos.side);
          if (apiPos) {
            // API positie gevonden — gebruik live PnL en prijs
            logPos.currentPx     = apiPos.currentPx;
            logPos.unrealizedPnl = apiPos.unrealizedPnl;
            logPos.totalPnl      = apiPos.totalPnl;
            logPos.positionValue = apiPos.positionValue || logPos.positionValue;
            logPos.leverage      = apiPos.leverage      || logPos.leverage;
            logPos.liquidationPx = apiPos.liquidationPx;
            logPos.marginUsed    = apiPos.marginUsed;
            logPos.returnOnEquity = apiPos.returnOnEquity;
            logPos.szi           = apiPos.szi;
          } else {
            // Geen API match (phantom agent) — bereken PnL met live prijzen
            try {
              const mids = await hlPostUrl(restUrl, { type: 'allMids' });
              const livePx = parseFloat(mids[logPos.asset] || 0);
              if (livePx > 0 && logPos.entryPrice > 0) {
                logPos.currentPx = livePx;
                const size = logPos.positionValue || 10;
                logPos.unrealizedPnl = logPos.side === 'SHORT'
                  ? (logPos.entryPrice - livePx) / logPos.entryPrice * size
                  : (livePx - logPos.entryPrice) / logPos.entryPrice * size;
                logPos.unrealizedPnl = Math.round(logPos.unrealizedPnl * 100) / 100;
                logPos.totalPnl = logPos.unrealizedPnl;
              }
            } catch (e) { /* live price update failed, keep stale PnL */ }
          }
        }
        // Log posities blijven de bron — niet overschrijven met alle API posities
      } else {
        // Geen log posities — toon niets (wallet posities zijn niet van deze bot)
        botStates[bot.id].positions = [];
      }
    } else {
      botStates[bot.id].positions = positions;
    }
    botStates[bot.id].accountValue = accountValue;
    botStates[bot.id].totalNtl     = totalNtl;
    // online is now managed by checkBotHealth() — don't override here

    broadcast('bot_update', { botId: bot.id, state: botStates[bot.id] });
  } catch (err) {
    console.error(`[HL ${bot.id}] Poll error:`, err.message);
  }
}

function pollAllPositions() {
  for (const bot of CONFIG.bots) {
    if (bot.enabled && bot.wallet_address && bot.type !== 'poly') pollBotPositions(bot);
  }
}

// ─── HL WebSocket ─────────────────────────────────────────
class HLManager {
  constructor() { this.ws = null; this.retryDelay = 1000; this.pingTimer = null; this.staleTimer = null; this.lastMsg = 0; }

  connect() {
    console.log('[HL] Connecting...');
    this.ws = new WebSocket(CONFIG.hyperliquid_ws);
    this.ws.on('open', () => {
      console.log('[HL] Connected');
      this.retryDelay = 1000;
      this.lastMsg = Date.now();
      for (const coin of CONFIG.assets) {
        this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'l2Book', coin } }));
        this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
      }
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'allMids' } }));
      this.pingTimer  = setInterval(() => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ method: 'ping' })), 45_000);
      this.staleTimer = setInterval(() => { if (Date.now() - this.lastMsg > 70_000) this.reconnect(); }, 15_000);
    });
    this.ws.on('message', (raw) => {
      this.lastMsg = Date.now();
      try {
        const msg = JSON.parse(raw);
        if (msg.channel === 'l2Book' && msg.data) {
          const { coin, levels, time } = msg.data;
          orderbooks[coin] = { coin, levels, time };
          broadcast('orderbook', { coin, levels, time });
        } else if (msg.channel === 'allMids' && msg.data?.mids) {
          Object.assign(mids, msg.data.mids);
          broadcast('mids', mids);
        } else if (msg.channel === 'trades' && msg.data) {
          for (const t of msg.data) {
            const px = parseFloat(t.px), sz = parseFloat(t.sz);
            const val = px * sz;
            const trade = {
              coin: t.coin,
              side: t.side === 'B' ? 'BUY' : 'SELL',
              dollar_value: Math.round(val),
              price: px,
              size: sz,
              time: t.time,
            };
            hlTradesBuffer.unshift(trade);
            if (hlTradesBuffer.length > 200) hlTradesBuffer.pop();
            broadcast('hl_trade', trade);

            // Liquidatie detectie: size-based heuristiek
            // HL WebSocket trades hebben geen 'crossed' veld; grote trades zijn waarschijnlijk liquidaties
            const LIQ_THRESHOLDS = { BTC: 50000, ETH: 25000, SOL: 20000, BNB: 20000 };
            const liqThreshold = LIQ_THRESHOLDS[t.coin] || 10000;
            if (val >= liqThreshold) {
              const liqEvent = {
                symbol: t.coin,
                side: t.side === 'B' ? 'SHORT' : 'LONG',  // B = short gets liquidated, S = long gets liquidated
                dollar_value: Math.round(val),
                price: px,
                timestamp: new Date(t.time).toISOString(),
              };
              liveFeedEvents.unshift(liqEvent);
              if (liveFeedEvents.length > 100) liveFeedEvents.pop();
              broadcast('live_feed_event', liqEvent);
              // Persist to disk (debounced via write coalescing)
              if (!global._lfSaveTimer) {
                global._lfSaveTimer = setTimeout(() => {
                  try { fs.writeFileSync(LF_CACHE_FILE, JSON.stringify(liveFeedEvents)); } catch {}
                  global._lfSaveTimer = null;
                }, 5000);
              }
              console.log(`[LIQ] ${liqEvent.symbol} ${liqEvent.side} $${liqEvent.dollar_value} @ $${px}`);
            }
          }
        }
      } catch {}
    });
    this.ws.on('close', () => { this.cleanup(); this.scheduleReconnect(); });
    this.ws.on('error', () => { this.cleanup(); this.scheduleReconnect(); });
  }
  cleanup() { clearInterval(this.pingTimer); clearInterval(this.staleTimer); }
  scheduleReconnect() { setTimeout(() => this.connect(), this.retryDelay); this.retryDelay = Math.min(this.retryDelay * 2, 30_000); }
  reconnect() { this.ws?.removeAllListeners(); this.ws?.terminate(); this.cleanup(); this.connect(); }
}

// ─── WS clients ──────────────────────────────────────────
wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[WS] Client connected (${clients.size} total)`);

  // Send initial state for all bots
  for (const ob of Object.values(orderbooks)) send(ws, 'orderbook', ob);
  if (Object.keys(mids).length) send(ws, 'mids', mids);
  for (const [botId, state] of Object.entries(botStates)) {
    send(ws, 'bot_update', { botId, state });
  }
  send(ws, 'process_status', botProcessAlive);

  // Batch send liquidation events
  if (liveFeedEvents.length) send(ws, 'live_feed_batch', liveFeedEvents);
  // Batch send HL trades (was 200 individual messages)
  if (hlTradesBuffer.length) send(ws, 'hl_trade_batch', hlTradesBuffer);
  // Send funding rates and spreads
  if (Object.keys(hlFundingRates).length) send(ws, 'hl_funding', hlFundingRates);
  if (Object.keys(spreadData).length) send(ws, 'spreads', spreadData);

  ws.on('message', (raw) => {
    // No terminal input needed anymore
  });

  ws.on('close', () => {
    clients.delete(ws);
  });

  ws.on('error', () => {});
});

// ─── Live Feed: Hyperliquid Liquidations ─────────────────
const LF_CACHE_FILE = path.join(__dirname, 'data', 'liq_events_cache.json');
let liveFeedEvents = [];
// Restore cached liquidation events from disk
try {
  if (fs.existsSync(LF_CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(LF_CACHE_FILE, 'utf8'));
    if (Array.isArray(cached)) {
      // Only keep events from last 24h
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      liveFeedEvents = cached.filter(e => new Date(e.timestamp).getTime() > cutoff).slice(0, 100);
      console.log(`[LIQ] Restored ${liveFeedEvents.length} cached events`);
    }
  }
} catch (e) { /* ignore corrupt cache */ }

// ─── HL Funding Rates poller ─────────────────────────────
let hlFundingRates = {};

async function pollHLFunding() {
  try {
    const data = await hlPost({ type: 'metaAndAssetCtxs' });
    if (!data || !Array.isArray(data) || data.length < 2) return;
    const meta = data[0];
    const ctxs = data[1];
    const rates = {};
    for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
      const coin = meta.universe[i].name;
      const ctx = ctxs[i];
      if (ctx.funding) {
        rates[coin] = {
          rate: parseFloat(ctx.funding),
          premium: parseFloat(ctx.premium || 0),
          openInterest: parseFloat(ctx.openInterest || 0),
          markPx: parseFloat(ctx.markPx || 0),
        };
      }
    }
    hlFundingRates = rates;
    broadcast('hl_funding', rates);
  } catch (e) {
    console.error('[HL funding] Poll error:', e.message);
  }
}

// ─── Cross-exchange spread: Binance vs HL ────────────────
let binancePrices = {};
let spreadData = {};

async function pollBinancePrices() {
  return new Promise((resolve, reject) => {
    const url = new URL('https://fapi.binance.com/fapi/v1/ticker/price');
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const tickers = JSON.parse(data);
          for (const t of tickers) {
            binancePrices[t.symbol] = parseFloat(t.price);
          }
          resolve();
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function pollSpreads() {
  try {
    await pollBinancePrices();
    const spreads = {};
    for (const coin of CONFIG.assets) {
      const binKey = coin + 'USDT';
      const binPx = binancePrices[binKey];
      const hlPx = parseFloat(mids[coin] || 0);
      if (binPx && hlPx) {
        const diff = hlPx - binPx;
        const pct = (diff / binPx) * 100;
        spreads[coin] = { binance: binPx, hl: hlPx, diff: Math.round(diff * 100) / 100, pct: Math.round(pct * 10000) / 10000 };
      }
    }
    spreadData = spreads;
    broadcast('spreads', spreads);
  } catch (e) {
    console.error('[Spread] Poll error:', e.message);
  }
}

// ─── Boot ────────────────────────────────────────────────
new HLManager().connect();
setupBotWatchers();
setInterval(pollAllPositions, 3000);
pollAllPositions();
setInterval(pollHLFunding, 10000);
pollHLFunding();
setInterval(pollSpreads, 3000);
setTimeout(pollSpreads, 2000); // Wait for HL mids to arrive first
setInterval(checkBotHealth, 15_000); // Process + log freshness check every 15s
checkBotHealth();
server.listen(CONFIG.port, () => console.log(`Dashboard -> http://localhost:${CONFIG.port}`));
process.on('uncaughtException', err => console.error('[ERR]', err.message));
