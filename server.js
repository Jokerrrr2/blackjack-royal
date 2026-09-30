"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;

/* ============================================================
   SERVEUR HTTP (sert index.html)
   ============================================================ */
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    const file = path.join(__dirname, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); res.end("Erreur"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

/* ============================================================
   CARTES
   ============================================================ */
const RANKS = "A23456789TJQK";
const SUITS = ["♠", "♥", "♦", "♣"];
const rank = c => c % 13;
const suit = c => Math.floor(c / 13);
const isAce = c => rank(c) === 0;
const cardVal = c => isAce(c) ? 11 : Math.min(10, rank(c) + 1);

function handValue(h) {
  let t = 0, a = 0;
  for (const c of h) { t += cardVal(c); if (isAce(c)) a++; }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return t;
}
function isSoftHand(h) {
  let t = 0, a = 0;
  for (const c of h) { t += cardVal(c); if (isAce(c)) a++; }
  while (t > 21 && a > 0) { t -= 10; a--; }
  return a > 0 && t <= 21;
}
const isBlackjack = h => h.length === 2 && handValue(h) === 21;

function newShoe() {
  const a = [];
  for (let d = 0; d < 6; d++) for (let c = 0; c < 52; c++) a.push(c);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const PLAYER_COLORS = ["#ffd65a", "#61e6a4", "#7ab8ff", "#e07ad6", "#ff9b5a"];
const MAX_PLAYERS = 5;
const DEFAULT_CHIPS = 500;
const CARD_DELAY = 900;
const ACTION_TIME_MS = 45000;

const tables = new Map();

/* ============================================================
   TABLE
   ============================================================ */
function makeTable(code) {
  return {
    code,
    players: [],
    shoe: newShoe(),
    pos: 0,
    dealer: [],
    phase: "bet",              // bet | insure | play | dealerTurn | results
    activeSeat: -1,
    round: 0,
    history: [],
    actionDeadline: 0,
    actionTimer: null,
    insurance: { pending: false, cost: 0, accepted: false },
    dealing: false,
    revealing: false
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function publicState(table) {
  const hideHole =
    table.phase === "play" ||
    table.phase === "insure" ||
    table.phase === "dealing" ||
    table.phase === "revealing";
  const isReveal = table.phase === "reveal";
  return {
    code: table.code,
    phase: table.phase,
    round: table.round,
    activeSeat: table.activeSeat,
    dealer: {
      cards: table.dealer.map((c, i) => (hideHole && i === 1) ? -1 : c),
      total: hideHole
        ? (table.dealer.length ? handValue([table.dealer[0]]) : 0)
        : handValue(table.dealer),
      soft: !hideHole && isSoftHand(table.dealer),
      blackjack: !hideHole && isBlackjack(table.dealer),
      hidden: hideHole && table.dealer.length > 1,
      reveal: isReveal
    },
    insurance: table.insurance,
    players: table.players.map((p, i) => ({
      seat: i,
      name: p.name,
      color: p.color,
      chips: Math.round(p.chips * 100) / 100,
      bet: p.bet,
      lastBet: p.lastBet,
      occupied: p.occupied,
      hands: p.hands.map(h => ({
        cards: h.c,
        bet: h.b,
        status: h.s,
        result: h.r || null
      })),
      hi: p.hi,
      connected: !!(p.ws && p.ws.readyState === 1)
    })),
    history: table.history.slice(-30)
  };
}

function broadcast(table) {
  const state = publicState(table);
  for (const p of table.players) send(p.ws, { type: "state", state });
}

/* ============================================================
   TIMER D'ACTION
   ============================================================ */
function startActionTimer(table) {
  stopActionTimer(table);
  table.actionDeadline = Date.now() + ACTION_TIME_MS;
  table.actionTimer = setInterval(() => {
    broadcast(table);
    if (Date.now() >= table.actionDeadline) {
      stopActionTimer(table);
      autoStand(table);
    }
  }, 500);
}

function stopActionTimer(table) {
  if (table.actionTimer) { clearInterval(table.actionTimer); table.actionTimer = null; }
}

function autoStand(table) {
  if (table.phase !== "play") return;
  const p = table.players[table.activeSeat];
  if (!p) return;
  const h = p.hands[p.hi];
  if (!h || h.s !== "play") return;
  h.s = "stand";
  table.history.push("⏱ Temps écoulé — RESTER auto");
  advanceTurn(table);
}

/* ============================================================
   DÉMARRAGE D'UNE MANCHE
   ============================================================ */
function startRound(table) {
  const engaged = table.players
    .map((p, i) => ({ p, i }))
    .filter(x => x.p.occupied && x.p.bet >= 1);

  if (engaged.length === 0) {
    table.phase = "bet";
    table.dealer = [];
    table.activeSeat = -1;
    broadcast(table);
    return;
  }

  for (const p of table.players) {
    p.hands = [];
    p.hi = 0;
    p.ins = 0;
    p.insuranceDecided = false;
    p.lastBet = p.lastBet || 0;
  }
  table.dealer = [];
  table.round++;
  table.phase = "dealing";
  table.insurance = { pending: false, cost: 0, accepted: false };
  table.resolved = false;

  // Préparer les mains vides
  for (const x of engaged) {
    x.p.hands = [{ c: [], b: x.p.bet, s: "play", r: null }];
    x.p.chips -= x.p.bet;
    x.p.lastBet = x.p.bet;
  }
  broadcast(table);

  // Distribution de droite à gauche (index descendant)
  const order = engaged.map(x => x.i).sort((a, b) => b - a);
  const sequence = [];
  for (const i of order) sequence.push({ type: "player", seat: i });
  sequence.push({ type: "dealer" });
  for (const i of order) sequence.push({ type: "player", seat: i });
  sequence.push({ type: "dealer" });

  let idx = 0;
  function nextCard() {
    if (idx >= sequence.length) {
      finishDistribution(table, engaged);
      return;
    }
    const step = sequence[idx++];
    if (step.type === "player") {
      table.players[step.seat].hands[0].c.push(table.shoe[table.pos++]);
    } else {
      table.dealer.push(table.shoe[table.pos++]);
    }
    broadcast(table);
    setTimeout(nextCard, CARD_DELAY);
  }
  nextCard();
}

function finishDistribution(table, engaged) {
  // Blackjacks
  for (const x of engaged) {
    if (isBlackjack(x.p.hands[0].c)) {
      x.p.hands[0].s = "bj";
      table.history.push(`♠ Blackjack pour ${x.p.name} !`);
    }
  }

  // Assurance si As visible et au moins un joueur sans BJ
  const dealerUp = table.dealer[0];
  const needInsure = isAce(dealerUp) && engaged.some(x => x.p.hands[0].s !== "bj");

  if (needInsure) {
    table.phase = "insure";
    broadcast(table);
    return;
  }

  afterInsurance(table);
}

function afterInsurance(table) {
  const anyPlayable = table.players.some(p => p.hands.some(h => h.s === "play"));

  if (!anyPlayable) {
    table.phase = "revealing";
    broadcast(table);
    setTimeout(() => startDealerReveal(table), 600);
  } else {
    table.phase = "play";
    const first = table.players.findIndex(p => p.hands.some(h => h.s === "play"));
    table.activeSeat = first;
    table.players[first].hi = table.players[first].hands.findIndex(h => h.s === "play");
    startActionTimer(table);
    broadcast(table);
  }
}

/* ============================================================
   ACTIONS
   ============================================================ */
function playerAction(table, seat, action) {
  if (table.phase !== "play") return;
  if (seat !== table.activeSeat) return;
  const p = table.players[seat];
  const h = p.hands[p.hi];
  if (!h || h.s !== "play") return;

  if (action === "hit") {
    h.c.push(table.shoe[table.pos++]);
    const v = handValue(h.c);
    if (v > 21) {
      h.s = "bust";
      table.history.push(`${p.name} bust à ${v}`);
      advanceTurn(table);
    } else if (v === 21) {
      h.s = "stand";
      table.history.push(`${p.name} fait 21`);
      advanceTurn(table);
    }
  } else if (action === "stand") {
    h.s = "stand";
    table.history.push(`${p.name} reste à ${handValue(h.c)}`);
    advanceTurn(table);
  } else if (action === "double") {
    if (h.c.length !== 2 || p.chips < h.b) return;
    p.chips -= h.b;
    h.b *= 2;
    h.c.push(table.shoe[table.pos++]);
    const v = handValue(h.c);
    h.s = v > 21 ? "bust" : "stand";
    table.history.push(`${p.name} double → ${v}`);
    advanceTurn(table);
  } else if (action === "split") {
    if (p.hands.length !== 1 || h.c.length !== 2) return;
    if (cardVal(h.c[0]) !== cardVal(h.c[1])) return;
    if (p.chips < h.b) return;
    p.chips -= h.b;
    const a = h.c[0], b = h.c[1];
    const aAce = isAce(a), bAce = isAce(b);
    p.hands = [
      { c: [a, table.shoe[table.pos++]], b: h.b, s: aAce ? "stand" : "play", r: null },
      { c: [b, table.shoe[table.pos++]], b: h.b, s: bAce ? "stand" : "play", r: null }
    ];
    p.hi = p.hands.findIndex(x => x.s === "play");
    table.history.push(`${p.name} split`);
    if (p.hi < 0) advanceTurn(table);
    else broadcast(table);
  }
}

function advanceTurn(table) {
  const p = table.players[table.activeSeat];
  const ni = p.hands.findIndex(x => x.s === "play");
  if (ni >= 0) {
    p.hi = ni;
    startActionTimer(table);
    broadcast(table);
    return;
  }
  // Chercher joueur suivant
  const next = table.players.findIndex((x, i) => i > table.activeSeat && x.hands.some(h => h.s === "play"));
  if (next >= 0) {
    table.activeSeat = next;
    table.players[next].hi = table.players[next].hands.findIndex(h => h.s === "play");
    startActionTimer(table);
    broadcast(table);
  } else {
    stopActionTimer(table);
    table.phase = "revealing";
    broadcast(table);
    setTimeout(() => startDealerReveal(table), 500);
  }
}

/* ============================================================
   ASSURANCE
   ============================================================ */
function handleInsurance(table, seat, take) {
  if (table.phase !== "insure") return;
  const p = table.players[seat];
  if (!p) return;

  let totalCost = 0;
  for (const x of table.players) {
    if (x.hands.length && x.hands[0].s !== "bj") totalCost += x.hands[0].b / 2;
  }

  if (take) {
    if (p.chips >= totalCost) {
      p.chips -= totalCost;
      table.insurance = { pending: false, cost: totalCost, accepted: true };
      table.history.push(`${p.name} prend l'assurance (${totalCost.toFixed(2)} €)`);
    }
  } else {
    table.insurance = { pending: false, cost: 0, accepted: false };
    table.history.push(`${p.name} refuse l'assurance`);
  }

  afterInsurance(table);
}

/* ============================================================
   RÉVÉLATION DU CROUPIER
   ============================================================ */
function startDealerReveal(table) {
  table.phase = "reveal";
  broadcast(table);
  setTimeout(() => {
    table.phase = "dealerTurn";
    broadcast(table);
    setTimeout(() => dealerPlay(table), 500);
  }, 2800);
}

function dealerPlay(table) {
  if (table.phase !== "dealerTurn") return;
  const dbj = isBlackjack(table.dealer);
  if (!dbj) {
    while (handValue(table.dealer) < 17) {
      table.dealer.push(table.shoe[table.pos++]);
    }
  }
  resolve(table);
}

/* ============================================================
   RÉSOLUTION
   ============================================================ */
function resolve(table) {
  if (table.resolved) return;
  table.resolved = true;

  const dv = handValue(table.dealer);
  const dbj = isBlackjack(table.dealer);
  let totalNet = 0;

  for (const p of table.players) {
    if (!p.hands.length) continue;
    for (const h of p.hands) {
      const v = handValue(h.c);
      let pay = 0, r = "Perdu";
      if (h.s === "bust") { }
      else if (h.s === "bj") {
        if (dbj) { pay = h.b; r = "Égalité"; }
        else { pay = h.b * 2.5; r = "BLACKJACK !"; }
      } else {
        if (dbj) r = "Perdu (BJ)";
        else if (dv > 21) { pay = h.b * 2; r = "Gagné"; }
        else if (v > dv) { pay = h.b * 2; r = "Gagné"; }
        else if (v === dv) { pay = h.b; r = "Égalité"; }
      }
      h.r = r;
      h.net = pay - h.b;
      p.chips += pay;
      totalNet += h.net;
      table.history.push(`${p.name} ${r} ${(h.net >= 0 ? "+" : "") + h.net.toFixed(2)} €`);
    }
  }

  if (table.insurance && table.insurance.accepted && dbj) {
    p_loop: for (const p of table.players) {
      if (p.hands.length && p.hands[0].s !== "bj") {
        p.chips += table.insurance.cost * 3;
        table.history.push(`Assurance gagnée pour ${p.name}`);
        break p_loop;
      }
    }
  }

  table.history.push(`── Fin main #${table.round} — net : ${totalNet.toFixed(2)} €`);
  if (table.history.length > 100) table.history.shift();
  table.phase = "results";
  stopActionTimer(table);
  broadcast(table);
}

/* ============================================================
   GESTION JOUEURS
   ============================================================ */
function joinTable(ws, code, name, chips) {
  code = String(code || "").toUpperCase().trim();
  name = String(name || "").trim().slice(0, 14);
  chips = Math.max(10, Math.min(100000, Number(chips) || DEFAULT_CHIPS));

  if (!code || !name) {
    send(ws, { type: "error", message: "Code et nom obligatoires" });
    return;
  }

  let table = tables.get(code);
  if (!table) {
    table = makeTable(code);
    tables.set(code, table);
  }
  if (table.players.length >= MAX_PLAYERS) {
    send(ws, { type: "error", message: "Table complète (5 joueurs max)" });
    return;
  }

  const seat = table.players.length;
  const player = {
    id: Math.random().toString(36).slice(2, 8),
    name,
    color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
    chips,
    bet: 0,
    lastBet: 0,
    hands: [],
    hi: 0,
    ins: 0,
    occupied: true,
    insuranceDecided: false,
    ws
  };
  table.players.push(player);
  ws.tableCode = code;
  ws.seat = seat;

  send(ws, { type: "joined", seat, code, name });
  broadcast(table);
}

function leaveTable(ws) {
  const code = ws.tableCode;
  if (!code) return;
  const table = tables.get(code);
  if (!table) return;
  const seat = ws.seat;
  if (typeof seat !== "number") return;

  if (table.players[seat]) {
    table.players[seat].ws = null;
    table.players[seat].occupied = false;
  }
  if (table.players.every(p => !p.ws)) {
    stopActionTimer(table);
    tables.delete(code);
  } else {
    broadcast(table);
  }
}

/* ============================================================
   WEBSOCKET
   ============================================================ */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  send(ws, { type: "hello" });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const table = tables.get(ws.tableCode);

    switch (msg.type) {
      case "join": joinTable(ws, msg.code, msg.name, msg.chips); break;

      case "bet": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "bet") return;
        const p = table.players[ws.seat];
        if (!p) return;
        const v = Math.max(0, Math.min(100, Number(msg.amount) || 0));
        p.bet = Math.min(v, p.chips);
        broadcast(table);
        break;
      }
      case "clearBet": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "bet") return;
        const p = table.players[ws.seat];
        if (p) p.bet = 0;
        broadcast(table);
        break;
      }
      case "repeatBet": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "bet") return;
        const p = table.players[ws.seat];
        if (!p) return;
        if (p.lastBet > 0) p.bet = Math.min(p.lastBet, p.chips, 100);
        broadcast(table);
        break;
      }
      case "doubleBet": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "bet") return;
        const p = table.players[ws.seat];
        if (!p) return;
        p.bet = Math.min(p.chips, p.bet * 2, 100);
        broadcast(table);
        break;
      }
      case "deal": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "bet") return;
        startRound(table);
        break;
      }
      case "hit": if (table && ws.seat != null) playerAction(table, ws.seat, "hit"); break;
      case "stand": if (table && ws.seat != null) playerAction(table, ws.seat, "stand"); break;
      case "double": if (table && ws.seat != null) playerAction(table, ws.seat, "double"); break;
      case "split": if (table && ws.seat != null) playerAction(table, ws.seat, "split"); break;
      case "insure": if (table && ws.seat != null) handleInsurance(table, ws.seat, true); break;
      case "refuseInsure": if (table && ws.seat != null) handleInsurance(table, ws.seat, false); break;
      case "next": {
        if (!table || ws.seat == null) return;
        if (table.phase !== "results") return;
        for (const p of table.players) {
          p.hands = [];
          p.bet = 0;
          p.ins = 0;
          p.hi = 0;
          p.insuranceDecided = false;
        }
        table.dealer = [];
        table.phase = "bet";
        table.activeSeat = -1;
        table.resolved = false;
        broadcast(table);
        break;
      }
    }
  });

  ws.on("close", () => leaveTable(ws));
});

server.listen(PORT, () => {
  console.log("♠ Blackjack Royal — serveur en écoute sur le port " + PORT);
});
