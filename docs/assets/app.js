/* Tshwane Votes 2026 — ward map of past results, poll projection and the live IEC count. */
(() => {
'use strict';

// ---------------------------------------------------------------- constants
const NAMES = { ANC: 'ANC', DA: 'DA', EFF: 'EFF', ASA: 'ActionSA', FFP: 'FF Plus', MK: 'MK', PA: 'PA', ACDP: 'ACDP', IND: 'Independents', OTH: 'Others' };
const SHORT = { ...NAMES, IND: 'Indep.' };
const FULL = {
  ANC: 'African National Congress', DA: 'Democratic Alliance', EFF: 'Economic Freedom Fighters', ASA: 'ActionSA',
  FFP: 'Freedom Front Plus', MK: 'uMkhonto weSizwe Party', PA: 'Patriotic Alliance', ACDP: 'African Christian Democratic Party',
  IND: 'Independent ward candidates', OTH: 'All other parties',
};
const POLLED = ['ANC', 'DA', 'EFF', 'ASA', 'FFP', 'MK', 'PA'];
const SEAT_ORDER = ['EFF', 'MK', 'ANC', 'PA', 'OTH', 'IND', 'ASA', 'ACDP', 'FFP', 'DA'];
const PRESETS = [
  { name: 'DA + ActionSA + FF Plus', p: ['DA', 'ASA', 'FFP'] },
  { name: 'DA + ActionSA + FF Plus + ACDP', p: ['DA', 'ASA', 'FFP', 'ACDP'] },
  { name: 'ANC + EFF + ActionSA', p: ['ANC', 'EFF', 'ASA'] },
  { name: 'ANC + EFF + MK', p: ['ANC', 'EFF', 'MK'] },
  { name: 'ANC + DA', p: ['ANC', 'DA'] },
];
const MAJORITY = 108;
const N_SIMS = 1000;
const TZ = 'Africa/Johannesburg';
const POLL_SECONDS = 60;
const qs = new URLSearchParams(location.search);
const DATA = (document.querySelector('meta[name="data-base"]') || {}).content || 'data/';
const FEED = qs.get('feed') || DATA + 'live.json';
const HIST = qs.get('history') || FEED.replace(/live\.json(\?.*)?$/, 'live-history.json');

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = (a) => a.reduce((x, y) => x + y, 0);
const fmt = (x, d = 1) => (x == null || !isFinite(x) ? '–' : x.toFixed(d));
const pct = (x, d = 1) => (x == null || !isFinite(x) ? '–' : (x * 100).toFixed(d) + '%');
const pp = (x) => (x == null || !isFinite(x) ? '–' : x >= 0.995 ? '>99%' : x <= 0.005 ? '<1%' : Math.round(x * 100) + '%');
const int = (x) => (x == null || !isFinite(x) ? '–' : Math.round(x).toLocaleString('en-ZA'));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const timeSAST = (iso, withDay) => {
  if (!iso) return '–';
  const o = { hour: '2-digit', minute: '2-digit', timeZone: TZ, hour12: false };
  if (withDay) Object.assign(o, { weekday: 'short', day: 'numeric', month: 'short' });
  return new Intl.DateTimeFormat('en-ZA', o).format(new Date(iso));
};

// seeded RNG so projections are stable between renders
function rng(seed) {
  let s = seed >>> 0 || 1;
  const u = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  u.normal = () => { let a = 0; while (a === 0) a = u(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * u()); };
  return u;
}

// ---------------------------------------------------------------- state
const S = {
  st: null, geo: null, live: null, realLive: null, hist: [], realHist: [],
  mode: 'live', past: 'lge2021_ward', colorBy: null, party: 'DA', view: 'geo', base: true,
  sel: null, override: null, proj: null, now: null, rehearsal: null, tl: null,
  coalition: new Set(['DA', 'ASA', 'FFP']), changed: new Set(), lastUpdated: null, vdOn: false, vdGeo: null,
};
let G, K, GI, W, WI, VDI;   // groups, count, group index, wards, ward index by id, VD rows by id

// ---------------------------------------------------------------- colour
let C = {};
function readColours() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue(n).trim();
  C = { bg: get('--map-bg'), surface: get('--surface'), ink: get('--ink'), ink3: get('--ink-3'), line: get('--line'), edge: get('--ward-edge'),
    neg: get('--div-neg'), mid: get('--div-mid'), pos: get('--div-pos'), accent: get('--accent'), live: get('--live'), p: {} };
  for (const g of G) C.p[g] = get('--p-' + g) || '#888';
  C.dark = luminance(C.surface) < 0.3;
}
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(h) { const [r, g, b] = hex2rgb(h || '#ffffff'); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
function mix(a, b, t) { // t = weight of a
  const A = hex2rgb(a), B = hex2rgb(b);
  return '#' + A.map((x, i) => Math.round(x * t + B[i] * (1 - t)).toString(16).padStart(2, '0')).join('');
}
const STRENGTH = [0.32, 0.52, 0.76, 1];
const pc = (g) => C.p[g] || '#888';

// ---------------------------------------------------------------- data helpers
function shares(v) { const t = sum(v); return t > 0 ? v.map((x) => x / t) : v.map(() => 0); }
function order(sh) { return sh.map((x, k) => [k, x]).sort((a, b) => b[1] - a[1]); }
function winner(sh) { const o = order(sh); return { k: o[0][0], s: o[0][1], k2: o[1][0], s2: o[1][1], margin: o[0][1] - o[1][1] }; }
function wardHist(w, e) { return w.h[e] || null; }

// ---------------------------------------------------------------- poll average
function pollAverage(polls) {
  const ref = Date.parse(S.st.electionDay);
  const acc = {}, wsum = {}, sq = {};
  for (const p of polls) {
    const days = Math.max(0, (ref - Date.parse(p.fieldwork_end)) / 864e5);
    const w = Math.pow(0.5, days / 30) * Math.sqrt(p.n);
    const tot = sum(Object.values(p.s));
    const scale = tot > 100 ? 100 / tot : 1;
    for (const [k, v] of Object.entries(p.s)) {
      acc[k] = (acc[k] || 0) + w * v * scale; wsum[k] = (wsum[k] || 0) + w; sq[k] = (sq[k] || 0) + w * (v * scale) ** 2;
    }
  }
  const avg = {}, sd = {};
  for (const k in acc) { avg[k] = acc[k] / wsum[k]; sd[k] = Math.sqrt(Math.max(0, sq[k] / wsum[k] - avg[k] ** 2)); }
  return { avg, sd };
}

function targetShares() {
  const pa = pollAverage(S.st.polls);
  const base = shares(S.st.city.lge2021_ward.v);
  const restKeys = G.filter((g) => !POLLED.includes(g));
  const restBase = sum(restKeys.map((g) => base[GI[g]]));
  const src = S.override || pa.avg;
  const T = new Array(K).fill(0);
  let polled = 0;
  for (const g of POLLED) { T[GI[g]] = Math.max(0.1, src[g] ?? 0); polled += T[GI[g]]; }
  // what polls leave for small parties/independents is noisy; blend it with the 2021 level
  const restPoll = Math.max(0, 100 - polled);
  const rest = S.override ? Math.max(0, 100 - polled) : 0.5 * restPoll + 0.5 * restBase * 100;
  const scale = S.override ? 1 : (100 - rest) / polled;
  for (const g of POLLED) T[GI[g]] *= scale;
  for (const g of restKeys) T[GI[g]] = rest * (base[GI[g]] / (restBase || 1));
  const tot = sum(T);
  return { T: T.map((x) => x / tot), sd: pa.sd, avg: pa.avg };
}

// ---------------------------------------------------------------- projection model
function baseline() {
  // per-ward baseline shares: 65% last local ward ballot + 35% 2024 national ballot (both on 2026 wards)
  const B = [], E = [];
  const t21 = sum(S.st.city.lge2021_ward.v), t24 = sum(S.st.city.npe2024.v);
  for (const w of W) {
    const h21 = w.h.lge2021_ward, h24 = w.h.npe2024;
    const s21 = h21 ? shares(h21.v) : null, s24 = h24 ? shares(h24.v) : null;
    const b = G.map((g, k) => {
      if (s21 && s24) return 0.65 * s21[k] + 0.35 * s24[k];
      return (s21 || s24 || [])[k] || 0;
    }).map((x) => x + 0.0005);
    B.push(shares(b));
    let e = null;
    if (h21 && h21.cov > 0.3) e = sum(h21.v) / h21.cov;
    else if (h24 && h24.cov > 0.3) e = (sum(h24.v) / h24.cov) * (t21 / t24);
    E.push(e || t21 / W.length);
  }
  return { B, E };
}

function fit(B, E, T, iters = 30) {
  const P = B.map((r) => r.slice());
  const Etot = sum(E);
  for (let it = 0; it < iters; it++) {
    const agg = new Array(K).fill(0);
    P.forEach((r, w) => r.forEach((x, k) => { agg[k] += E[w] * x; }));
    const ratio = agg.map((a, k) => (a > 0 ? (T[k] * Etot) / a : 0));
    for (const r of P) {
      let t = 0;
      for (let k = 0; k < K; k++) { r[k] *= ratio[k]; t += r[k]; }
      for (let k = 0; k < K; k++) r[k] /= t;
    }
  }
  return P;
}

// Municipal Structures Act, Schedule 1: seats by quota + largest remainder on each party's ward+PR votes,
// ward seats count first; a party that wins more wards than its entitlement keeps them (overhang).
// Works on "units" (individual parties): votes[], wins[]; indWards = wards won by independents.
function allocateUnits(votes, wins, indWards, seats = 214) {
  const n = votes.length, fixed = new Map();
  const units = [];
  for (let u = 0; u < n; u++) if (votes[u] > 0 || wins[u] > 0) units.push(u);
  const pool = seats - indWards;
  const out = new Array(n).fill(0);
  for (let it = 0; it < 8; it++) {
    const act = units.filter((u) => !fixed.has(u));
    let avail = pool;
    fixed.forEach((v) => { avail -= v; });
    const tv = act.reduce((a, u) => a + votes[u], 0);
    out.fill(0);
    fixed.forEach((v, u) => { out[u] = v; });
    if (tv <= 0 || avail <= 0) return out;
    const quota = Math.floor(tv / avail) + 1;
    const ent = act.map((u) => votes[u] / quota);
    const alloc = ent.map(Math.floor);
    let rem = avail - sum(alloc);
    const ord = ent.map((e, i) => [i, e - alloc[i]]).sort((a, b) => b[1] - a[1]);
    for (let j = 0; j < ord.length && rem > 0; j++, rem--) alloc[ord[j][0]]++;
    let over = false;
    act.forEach((u, i) => { if (wins[u] > alloc[i]) { fixed.set(u, wins[u]); over = true; } });
    if (!over || it === 7) { act.forEach((u, i) => { out[u] = alloc[i]; }); return out; }
  }
  return out;
}

// Small parties are pooled as "Others" in the model but win seats one by one, so split that pool
// the way it split on the 2021 PR ballot before allocating, then add the seats back up.
let OTH_SPLIT = null;
function othSplit() {
  if (OTH_SPLIT) return OTH_SPLIT;
  const all = (S.st.city.lge2021_pr.all || []).filter((r) => r[1] === 'OTH');
  const t = sum(all.map((r) => r[2])) || 1;
  OTH_SPLIT = all.map((r) => r[2] / t);
  return OTH_SPLIT.length ? OTH_SPLIT : [1];
}
function allocate(groupVotes, groupWins, seats = 214) {
  const IND = GI.IND, OTH = GI.OTH;
  const votes = [], wins = [], grp = [];
  for (let k = 0; k < K; k++) {
    if (k === IND) continue;
    if (k === OTH) {
      othSplit().forEach((f, j) => { votes.push(groupVotes[k] * f); wins.push(j === 0 ? groupWins[k] || 0 : 0); grp.push(k); });
    } else { votes.push(groupVotes[k]); wins.push(groupWins[k] || 0); grp.push(k); }
  }
  const u = allocateUnits(votes, wins, groupWins[IND] || 0, seats);
  const out = new Array(K).fill(0);
  u.forEach((x, i) => { out[grp[i]] += x; });
  out[IND] = groupWins[IND] || 0;
  return out;
}
// Exact allocation from named party totals (past results)
function allocateNamed(wardAll, prAll, groupWins, seats = 214) {
  const byName = new Map();
  for (const [n, g, v] of wardAll) if (g !== 'IND') byName.set(n, { g, v: (byName.get(n) || { v: 0 }).v + v });
  for (const [n, g, v] of prAll) if (g !== 'IND') byName.set(n, { g, v: (byName.get(n) || { v: 0 }).v + v });
  const names = [...byName.keys()];
  const votes = names.map((n) => byName.get(n).v);
  const wins = names.map(() => 0);
  G.forEach((g, k) => {   // give a group's ward wins to its biggest party
    if (g === 'IND' || !groupWins[k]) return;
    let best = -1;
    names.forEach((n, i) => { if (byName.get(n).g === g && (best < 0 || votes[i] > votes[best])) best = i; });
    if (best >= 0) wins[best] += groupWins[k];
  });
  const u = allocateUnits(votes, wins, groupWins[GI.IND] || 0, seats);
  const out = new Array(K).fill(0);
  names.forEach((n, i) => { out[GI[byName.get(n).g]] += u[i]; });
  out[GI.IND] = groupWins[GI.IND] || 0;
  return { groups: out, named: names.map((n, i) => [n, u[i]]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]) };
}

function seatsFromWardShares(P, E, prShares) {
  // P: ward-ballot shares per ward; ward votes = E*P; PR votes = same electorate, PR shares (no independents)
  const IND = GI.IND;
  const wv = new Array(K).fill(0), pr = new Array(K).fill(0), wins = new Array(K).fill(0);
  P.forEach((r, w) => {
    let best = 0;
    for (let k = 0; k < K; k++) { wv[k] += E[w] * r[k]; if (r[k] > r[best]) best = k; }
    wins[best]++;
    const q = prShares ? prShares[w] : r;
    const t = 1 - (prShares ? 0 : q[IND]);
    for (let k = 0; k < K; k++) if (k !== IND) pr[k] += (E[w] * q[k]) / t;
  });
  const comb = wv.map((v, k) => (k === IND ? 0 : v + pr[k]));
  return { seats: allocate(comb, wins), wins, wv, pr };
}

function project() {
  const { B, E } = baseline();
  const tg = targetShares();
  const P = fit(B, E, tg.T);
  const central = seatsFromWardShares(P, E);
  // simulations: city-wide error per party (poll spread + 2pt), ward error, turnout
  const r = rng(20261104);
  const win = W.map(() => new Float32Array(K));
  const seatSims = [];
  const shareSims = [];
  const sigma = G.map((g, k) => {
    const sdpp = Math.sqrt((tg.sd[g] || 2.5) ** 2 + 2 ** 2);
    return clamp(sdpp / Math.max(1, tg.T[k] * 100), 0.04, 0.6);
  });
  for (let s = 0; s < N_SIMS; s++) {
    const f = sigma.map((sg) => Math.exp(r.normal() * sg - (sg * sg) / 2));
    const Ps = P.map((row) => {
      const x = row.map((v, k) => v * f[k] * Math.exp(r.normal() * 0.2));
      const t = sum(x);
      return x.map((v) => v / t);
    });
    const Es = E.map((e) => e * Math.exp(r.normal() * 0.12));
    const res = seatsFromWardShares(Ps, Es);
    Ps.forEach((row, w) => { let b = 0; for (let k = 1; k < K; k++) if (row[k] > row[b]) b = k; win[w][b]++; });
    seatSims.push(Int16Array.from(res.seats));
    const tv = sum(res.wv);
    shareSims.push(res.wv.map((v) => v / tv));
  }
  const winProb = win.map((row) => Array.from(row, (x) => x / N_SIMS));
  const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
  const seatQ = G.map((g, k) => { const col = seatSims.map((s) => s[k]); return { lo: q(col, 0.1), med: q(col, 0.5), hi: q(col, 0.9) }; });
  const shareQ = G.map((g, k) => { const col = shareSims.map((s) => s[k]); return { lo: q(col, 0.1), hi: q(col, 0.9) }; });
  const largest = new Array(K).fill(0);
  seatSims.forEach((s) => { let b = 0; for (let k = 1; k < K; k++) if (s[k] > s[b]) b = k; largest[b]++; });
  return { B, E, P, T: tg.T, avg: tg.avg, sd: tg.sd, central, winProb, seatSims, seatQ, shareQ, largest: largest.map((x) => x / N_SIMS) };
}

// ---------------------------------------------------------------- live nowcast
function vdPriors() {
  // prior share for every 2026 VD: ward projection scaled by the VD's own baseline relative to its ward
  const pr = new Map();
  const { B, P } = S.proj;
  for (const [vd, wi, r21, r24, b21, b24] of S.st.vds) {
    const s21 = b21 && sum(b21) > 0 ? shares(b21) : null, s24 = b24 && sum(b24) > 0 ? shares(b24) : null;
    let q;
    if (s21 || s24) {
      const vb = G.map((g, k) => (s21 && s24 ? 0.65 * s21[k] + 0.35 * s24[k] : (s21 || s24)[k]));
      q = shares(P[wi].map((x, k) => x * (vb[k] + 0.01) / (B[wi][k] + 0.01)));
    } else q = P[wi].slice();
    const w = W[wi];
    let ev = b21 && sum(b21) > 0 ? sum(b21) : null;
    if (!ev && b24 && sum(b24) > 0) ev = sum(b24) * (sum(S.st.city.lge2021_ward.v) / sum(S.st.city.npe2024.v));
    if (!ev) ev = S.proj.E[wi] / w.nvd;
    pr.set(vd, { wi, q, ev });
  }
  return pr;
}

function nowcast(live) {
  if (!live || !live.vdsCounted) return null;
  const pri = S._pri || (S._pri = vdPriors());
  const counted = live.vd || {};
  // city-wide swing against the prior, shrunk towards none with 20k pseudo-votes
  const O = new Array(K).fill(0), Ex = new Array(K).fill(0);
  let A = 0, EV = 0;
  for (const [vd, v] of Object.entries(counted)) {
    const p = pri.get(vd); if (!p) continue;
    const a = sum(v); if (!a) continue;
    A += a; EV += p.ev;
    for (let k = 0; k < K; k++) { O[k] += v[k]; Ex[k] += p.q[k] * a; }
  }
  const m = 20000;
  const Ttot = sum(Ex) || 1;
  const rho = O.map((o, k) => (o + m * (Ex[k] / Ttot)) / (Ex[k] + m * (Ex[k] / Ttot) || 1));
  const tau = EV > 0 ? clamp(A / EV, 0.4, 2.5) : 1;
  // per-ward local adjustment from counted VDs in that ward
  const wO = W.map(() => new Array(K).fill(0)), wE = W.map(() => new Array(K).fill(0));
  for (const [vd, v] of Object.entries(counted)) {
    const p = pri.get(vd); if (!p) continue;
    const a = sum(v);
    const qq = shares(p.q.map((x, k) => x * rho[k]));
    for (let k = 0; k < K; k++) { wO[p.wi][k] += v[k]; wE[p.wi][k] += qq[k] * a; }
  }
  const lam = W.map((w, i) => {
    const te = sum(wE[i]);
    if (!te) return null;
    return wE[i].map((e, k) => (wO[i][k] + 400 * (e / te)) / (e + 400 * (e / te) || 1));
  });
  const known = W.map(() => new Array(K).fill(0));
  const unk = W.map(() => new Array(K).fill(0));
  const unkV = new Array(W.length).fill(0);
  const outVDs = W.map(() => []);
  for (const [vd, p] of pri) {
    const v = counted[vd];
    if (v && sum(v) > 0) { for (let k = 0; k < K; k++) known[p.wi][k] += v[k]; continue; }
    let q = p.q.map((x, k) => x * rho[k] * (lam[p.wi] ? lam[p.wi][k] : 1));
    q = shares(q);
    const ev = p.ev * tau;
    unkV[p.wi] += ev;
    for (let k = 0; k < K; k++) unk[p.wi][k] += q[k] * ev;
    outVDs[p.wi].push({ q, ev });
  }
  const est = W.map((w, i) => known[i].map((x, k) => x + unk[i][k]));
  // uncertainty on what is still out: shrinks as the city count progresses
  const frac = live.vdsCounted / Math.max(1, live.vdsTotal || S.st.vds.length);
  const sCity = 0.12 * (1 - frac) + 0.02, sVD = 0.22;
  const r = rng(live.vdsCounted * 7919 + 17);
  const NS = 300;
  const win = W.map(() => new Float32Array(K));
  const seatSims = [];
  for (let s = 0; s < NS; s++) {
    const f = G.map(() => Math.exp(r.normal() * sCity));
    const Pw = [];
    for (let i = 0; i < W.length; i++) {
      const tot = known[i].slice();
      for (const o of outVDs[i]) {
        const x = o.q.map((q, k) => q * f[k] * Math.exp(r.normal() * sVD));
        const t = sum(x);
        for (let k = 0; k < K; k++) tot[k] += (x[k] / t) * o.ev;
      }
      let b = 0; for (let k = 1; k < K; k++) if (tot[k] > tot[b]) b = k;
      win[i][b]++;
      Pw.push(tot);
    }
    if (s < 150) {
      const Ew = Pw.map((t) => sum(t));
      const res = seatsFromWardShares(Pw.map(shares), Ew);
      seatSims.push(Int16Array.from(res.seats));
    }
  }
  const winProb = win.map((row) => Array.from(row, (x) => x / NS));
  const Ew = est.map((t) => sum(t));
  const central = seatsFromWardShares(est.map(shares), Ew);
  const q = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.floor(p * (a.length - 1))]; };
  const seatQ = G.map((g, k) => { const col = seatSims.map((s) => s[k]); return { lo: q(col, 0.1), med: q(col, 0.5), hi: q(col, 0.9) }; });
  const cityEst = new Array(K).fill(0); est.forEach((r2) => r2.forEach((x, k) => { cityEst[k] += x; }));
  return { known, est, unkV, winProb, central, seatSims, seatQ, city: shares(cityEst), rho, tau, frac };
}

// ---------------------------------------------------------------- ward values per mode
function liveWard(id) {
  const L = S.tl != null && S.hist[S.tl] ? histLive(S.hist[S.tl]) : S.live;
  return L && L.wards ? L.wards[id] : null;
}
function histLive(snap) {
  const wards = {};
  for (const [id, a] of Object.entries(snap.w || {})) wards[id] = { n: a[0], v: a.slice(1), N: W[WI[id]] ? W[WI[id]].nvd : 0 };
  return { wards, vdsCounted: snap.n, city: snap.city, updated: snap.t };
}

function wardInfo(i) {
  const w = W[i];
  if (S.mode === 'results') {
    const h = wardHist(w, S.past);
    if (!h) return null;
    const sh = shares(h.v);
    return { sh, votes: sum(h.v), reg: h.reg, cov: h.cov, ...winner(sh), status: 'result' };
  }
  if (S.mode === 'projection') {
    const sh = S.proj.P[i];
    const wp = S.proj.winProb[i];
    const wn = winner(sh);
    return { sh, votes: S.proj.E[i], wp, prob: wp[wn.k], ...wn, status: 'projection' };
  }
  // live
  const lw = liveWard(w.id);
  const nc = S.now && S.tl == null ? S.now : null;
  if (!lw || !lw.n) {
    const sh = S.proj.P[i];
    return { sh, votes: 0, n: 0, N: lw ? lw.N : w.nvd, ...winner(sh), status: 'awaiting', proj: true, wp: S.proj.winProb[i] };
  }
  const sh = shares(lw.v);
  const out = { sh, votes: sum(lw.v), n: lw.n, N: lw.N || w.nvd, reg: lw.reg, top: lw.top, ...winner(sh) };
  out.status = out.n >= out.N ? 'complete' : 'counting';
  if (nc) {
    out.est = shares(nc.est[i]);
    out.wp = nc.winProb[i];
    const ew = winner(out.est);
    out.estK = ew.k; out.prob = out.wp[ew.k];
    out.remaining = nc.unkV[i];
    const lead = (out.s - out.s2) * out.votes;
    out.safe = out.status === 'complete' || lead > out.remaining * 1.05;
  }
  return out;
}

function ratingLabel(p) { return p >= 0.9 ? 'Safe' : p >= 0.75 ? 'Likely' : p >= 0.6 ? 'Lean' : 'Toss-up'; }
function strengthOfProb(p) { return p >= 0.9 ? 3 : p >= 0.75 ? 2 : p >= 0.6 ? 1 : 0; }
function strengthOfMargin(m) { return m >= 0.3 ? 3 : m >= 0.15 ? 2 : m >= 0.05 ? 1 : 0; }

// previous comparable shares for swing maps
function prevShares(i) {
  const w = W[i];
  if (S.mode === 'results') {
    const prev = { lge2021_ward: 'lge2016_ward', lge2021_pr: 'lge2016_pr', npe2024: 'lge2021_ward', lge2016_ward: null, lge2016_pr: null }[S.past];
    const h = prev && wardHist(w, prev);
    return h ? shares(h.v) : null;
  }
  const h = wardHist(w, 'lge2021_ward');
  return h ? shares(h.v) : null;
}

const SEQ = [0.1, 0.26, 0.42, 0.58, 0.76, 1];
function seqColour(base, t) { return mix(base, C.bg, t); }

function colourModes() {
  if (S.mode === 'results') return [['winner', 'Winner'], ['share', 'Party share'], ['swing', 'Change since previous'], ['turnout', 'Turnout']];
  if (S.mode === 'projection') return [['winner', 'Favourite'], ['share', 'Party share'], ['prob', 'Win chance'], ['swing', 'Change since 2021']];
  return [['winner', 'Leader in count'], ['nowcast', 'Projected winner'], ['share', 'Party share'], ['swing', 'Change since 2021'], ['progress', 'Counting progress'], ['turnout', 'Turnout']];
}

function wardStyle(i) {
  const inf = wardInfo(i);
  const cb = S.colorBy;
  const none = { fill: mix(C.ink3, C.bg, 0.12), op: 1, hatch: false };
  if (!inf) return none;
  const P = GI[S.party];
  if (inf.status === 'awaiting' && cb !== 'progress') {
    // nothing counted: projected favourite as a pale wash
    return { fill: mix(pc(G[inf.k]), C.bg, 0.22), op: 1, pending: true };
  }
  switch (cb) {
    case 'share': {
      const v = inf.sh[P];
      const bin = v >= 0.5 ? 5 : Math.floor(v * 10);
      return { fill: seqColour(pc(S.party), SEQ[clamp(bin, 0, 5)]), op: 1 };
    }
    case 'prob': {
      const v = inf.wp ? inf.wp[P] : 0;
      const bins = [0.1, 0.25, 0.5, 0.75, 0.9];
      let b = 0; while (b < bins.length && v >= bins[b]) b++;
      return { fill: seqColour(pc(S.party), SEQ[b]), op: 1 };
    }
    case 'swing': {
      const prev = prevShares(i);
      if (!prev) return none;
      const d = (inf.sh[P] - prev[P]) * 100;
      const cuts = [-15, -7.5, -2.5, 2.5, 7.5, 15];
      let b = 0; while (b < cuts.length && d >= cuts[b]) b++;
      const cols = [mix(C.neg, C.mid, 1), mix(C.neg, C.mid, 0.66), mix(C.neg, C.mid, 0.33), C.mid, mix(C.pos, C.mid, 0.33), mix(C.pos, C.mid, 0.66), mix(C.pos, C.mid, 1)];
      return { fill: cols[b], op: 1 };
    }
    case 'turnout': {
      const t = inf.reg ? inf.votes / inf.reg : null;
      if (t == null || !isFinite(t)) return none;
      const b = clamp(Math.floor((t - 0.2) / 0.1), 0, 5);
      return { fill: seqColour(C.accent, SEQ[b]), op: 1 };
    }
    case 'progress': {
      const f = (inf.n || 0) / (inf.N || 1);
      if (!inf.n) return { fill: mix(C.ink3, C.bg, 0.1), op: 1 };
      return { fill: seqColour(C.ink, [0.25, 0.45, 0.65, 0.85, 1][f >= 1 ? 4 : Math.min(3, Math.floor(f * 4))]), op: 1 };
    }
    case 'nowcast': {
      if (inf.est) return { fill: mix(pc(G[inf.estK]), C.bg, STRENGTH[strengthOfProb(inf.prob)]), op: 1 };
      return { fill: mix(pc(G[inf.k]), C.bg, STRENGTH[strengthOfMargin(inf.margin)]), op: 1 };
    }
    default: {
      if (S.mode === 'projection') return { fill: mix(pc(G[inf.k]), C.bg, STRENGTH[strengthOfProb(inf.prob)]), op: 1 };
      if (S.mode === 'live') {
        const st = inf.status === 'complete' ? 3 : inf.safe ? 2 : strengthOfMargin(inf.margin) > 1 ? 1 : 0;
        return { fill: mix(pc(G[inf.k]), C.bg, STRENGTH[st]), op: 1, partial: inf.status === 'counting' };
      }
      return { fill: mix(pc(G[inf.k]), C.bg, STRENGTH[strengthOfMargin(inf.margin)]), op: 1 };
    }
  }
}

// ---------------------------------------------------------------- tooltip text
function tipHTML(i) {
  const w = W[i], inf = wardInfo(i);
  let h = `<h4>Ward ${w.no}</h4>`;
  if (!inf) return h + '<div class="muted">No data</div>';
  const rows = order(inf.est && S.colorBy === 'nowcast' ? inf.est : inf.sh).slice(0, 4);
  if (S.mode === 'live') {
    if (inf.status === 'awaiting') h += `<div class="muted">No voting districts counted yet (0 of ${inf.N})</div><div class="muted" style="margin-top:4px">Projected: ${NAMES[G[inf.k]]} ${pp(inf.wp ? inf.wp[inf.k] : null)} chance</div>`;
    else h += `<div class="muted">${inf.status === 'complete' ? 'All' : inf.n + ' of'} ${inf.N} voting districts counted · ${int(inf.votes)} votes</div>`;
  } else if (S.mode === 'projection') {
    h += `<div class="muted">${ratingLabel(inf.prob)} ${NAMES[G[inf.k]]} · ${pp(inf.prob)} chance</div>`;
  } else {
    h += `<div class="muted">${S.st.elections[S.past].label} · ${int(inf.votes)} votes</div>`;
  }
  if (inf.status !== 'awaiting') {
    h += '<div style="margin-top:6px;display:grid;gap:2px">' + rows.map(([k, x]) =>
      `<div class="row"><span class="sw" style="background:${pc(G[k])}"></span>${NAMES[G[k]]}<b>${pct(x)}</b></div>`).join('') + '</div>';
  }
  return h;
}

// ---------------------------------------------------------------- geo map
let map, wardLayer, labelLayer, placeLayer, tiles, layers = [];
function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: true, preferCanvas: false, zoomSnap: 0.25, minZoom: 8, maxZoom: 16 });
  map.attributionControl.setPrefix(false);
  setTiles();
  wardLayer = L.geoJSON(S.geo, {
    style: () => ({ weight: 0.8, color: C.edge, fillOpacity: 0.9 }),
    onEachFeature: (f, lyr) => {
      const i = WI[f.properties.id];
      layers[i] = lyr;
      lyr.bindTooltip(() => tipHTML(i), { sticky: true, className: 'tt', direction: 'top', offset: [0, -8] });
      lyr.on('click', () => select(W[i].id, false));
      lyr.on('mouseover', () => { lyr.setStyle({ weight: 2.5, color: C.ink }); lyr.bringToFront(); });
      lyr.on('mouseout', () => styleWard(i));
    },
  }).addTo(map);
  map.fitBounds(wardLayer.getBounds(), { padding: [10, 10] });
  map.createPane('labels'); map.getPane('labels').style.zIndex = 650; map.getPane('labels').style.pointerEvents = 'none';
  labelLayer = L.layerGroup(W.map((w) => L.marker([w.c[1], w.c[0]], {
    pane: 'labels', interactive: false, keyboard: false,
    icon: L.divIcon({ className: 'ward-lbl', html: String(w.no), iconSize: [24, 12], iconAnchor: [12, 6] }),
  })));
  if (S.st.places && S.st.places.length) placeLayer = L.layerGroup().addTo(map);
  map.on('zoomend moveend', labelVisibility);
  labelVisibility();
}
function labelVisibility() {
  const z = map.getZoom();
  if (z >= 11) labelLayer.addTo(map); else labelLayer.remove();
  if (!placeLayer) return;
  // greedy placement: most important names first, skip any that would overlap one already shown
  placeLayer.clearLayers();
  if (z < 9.6) return;
  const minRank = z >= 12.5 ? 0 : z >= 11 ? 1 : z >= 10.2 ? 1 : 2;
  const size = map.getSize();
  const boxes = [];
  if (z >= 11) W.forEach((w) => { const c = map.latLngToContainerPoint([w.c[1], w.c[0]]); boxes.push([c.x - 14, c.y - 8, c.x + 14, c.y + 8]); });
  const cand = S.st.places.filter((p) => p.lat != null && (p.r || 0) >= minRank).sort((a, b) => (b.r || 0) - (a.r || 0));
  for (const p of cand) {
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < 0 || pt.y < 0 || pt.x > size.x || pt.y > size.y) continue;
    const w = p.name.length * 7.2 + 8, h = 14;
    const box = [pt.x - w / 2, pt.y + 7, pt.x + w / 2, pt.y + 7 + h];
    if (boxes.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
    boxes.push(box);
    placeLayer.addLayer(L.marker([p.lat, p.lon], {
      pane: 'labels', interactive: false, keyboard: false,
      icon: L.divIcon({ className: 'place-lbl', html: esc(p.name), iconSize: [w, 12], iconAnchor: [w / 2, -8] }),
    }));
  }
}
let tileErrors = 0, tileLoads = 0;
function setTiles() {
  if (tiles) { tiles.remove(); tiles = null; }
  if (!S.base) return;
  const style = C.dark ? 'dark_all' : 'light_all';
  tiles = L.tileLayer(`https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`, {
    subdomains: 'abcd', maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>',
  });
  tiles.on('tileload', () => { tileLoads++; });
  tiles.on('tileerror', () => {
    tileErrors++;
    if (tileErrors > 6 && tileLoads === 0) { S.base = false; setTiles(); $('#basectrl').hidden = true; restyle(); }
  });
  tiles.addTo(map);
}
function styleWard(i) {
  const lyr = layers[i]; if (!lyr) return;
  const st = wardStyle(i);
  const sel = S.sel === W[i].id;
  if (S.vdOn) {
    lyr.setStyle({ fillColor: st.fill, fillOpacity: 0, color: C.ink, weight: sel ? 3.2 : 1.1, opacity: sel ? 1 : 0.7 });
  } else {
    lyr.setStyle({
      fillColor: st.fill, fillOpacity: S.base ? (st.pending ? 0.55 : 0.82) : 1,
      color: sel ? C.ink : C.edge, weight: sel ? 3 : 0.8, opacity: 1,
    });
  }
  if (sel) lyr.bringToFront();
}

// ---------------------------------------------------------------- voting-district layer
let vdLayer, vdRenderer;
function vdShares(vd) {
  if (S.mode === 'live') {
    if (S.tl != null) return null;
    const v = S.live && S.live.vd && S.live.vd[vd];
    return v && sum(v) ? { sh: shares(v), n: sum(v), kind: 'counted' } : null;
  }
  if (S.mode === 'projection') {
    const p = (S._pri || (S._pri = vdPriors())).get(vd);
    return p ? { sh: p.q, n: p.ev, kind: 'projected' } : null;
  }
  const row = VDI[vd]; if (!row) return null;
  const b = S.past.startsWith('lge2021') ? row[4] : S.past === 'npe2024' ? row[5] : null;
  return b && sum(b) ? { sh: shares(b), n: sum(b), kind: 'result' } : null;
}
function vdStyle(f) {
  const d = vdShares(f.properties.vd);
  if (!d) return { fillColor: mix(C.ink3, C.bg, 0.12), fillOpacity: 0.85, color: C.edge, weight: 0.4 };
  let fill;
  const P = GI[S.party];
  if (S.colorBy === 'share') {
    const bin = d.sh[P] >= 0.5 ? 5 : Math.floor(d.sh[P] * 10);
    fill = seqColour(pc(S.party), SEQ[clamp(bin, 0, 5)]);
  } else if (S.colorBy === 'swing' && VDI[f.properties.vd] && VDI[f.properties.vd][4]) {
    const prev = shares(VDI[f.properties.vd][4]);
    const dd = (d.sh[P] - prev[P]) * 100, cuts = [-15, -7.5, -2.5, 2.5, 7.5, 15];
    let b = 0; while (b < cuts.length && dd >= cuts[b]) b++;
    fill = [mix(C.neg, C.mid, 1), mix(C.neg, C.mid, 0.66), mix(C.neg, C.mid, 0.33), C.mid, mix(C.pos, C.mid, 0.33), mix(C.pos, C.mid, 0.66), mix(C.pos, C.mid, 1)][b];
  } else {
    const wn = winner(d.sh);
    fill = mix(pc(G[wn.k]), C.bg, STRENGTH[strengthOfMargin(wn.margin)]);
  }
  return { fillColor: fill, fillOpacity: S.base ? 0.85 : 1, color: C.edge, weight: 0.4 };
}
function vdTip(f) {
  const vd = f.properties.vd, d = vdShares(vd), w = W[WI[f.properties.w]];
  const nm = S.st.vdNames && S.st.vdNames[vd];
  let h = `<h4>VD ${vd}</h4><div class="muted">${nm ? esc(titleCase(nm)) + ' · ' : ''}Ward ${w ? w.no : ''}</div>`;
  if (!d) return h + `<div class="muted" style="margin-top:4px">${S.mode === 'live' ? 'Not counted yet' : 'No result at this level'}</div>`;
  h += `<div class="muted">${d.kind === 'counted' ? int(d.n) + ' votes counted' : d.kind === 'projected' ? 'Projection' : S.st.elections[S.past].short + ' · ' + int(d.n) + ' votes'}</div>`;
  return h + '<div style="margin-top:6px;display:grid;gap:2px">' + order(d.sh).slice(0, 4).map(([k, x]) =>
    `<div class="row"><span class="sw" style="background:${pc(G[k])}"></span>${NAMES[G[k]]}<b>${pct(x)}</b></div>`).join('') + '</div>';
}
async function toggleVDs(on) {
  S.vdOn = on;
  $('#l-w').setAttribute('aria-pressed', String(!on)); $('#l-vd').setAttribute('aria-pressed', String(on));
  if (on && !S.vdGeo) {
    try { S.vdGeo = await getJSON(DATA + 'vds.geojson'); } catch (e) { S.vdOn = false; $('#lvlctrl').hidden = true; restyle(); return; }
  }
  if (on && !vdLayer) {
    vdRenderer = L.canvas({ padding: 0.3 });
    vdLayer = L.geoJSON(S.vdGeo, {
      renderer: vdRenderer, style: vdStyle,
      onEachFeature: (f, lyr) => {
        lyr.bindTooltip(() => vdTip(f), { sticky: true, className: 'tt', direction: 'top', offset: [0, -8] });
        lyr.on('click', () => select(f.properties.w, false));
      },
    });
  }
  if (vdLayer) { if (on) { vdLayer.addTo(map); wardLayer.bringToFront(); } else vdLayer.remove(); }
  wardLayer.eachLayer((l) => { if (l._path) l._path.style.pointerEvents = on ? 'none' : ''; });
  restyle();
}
function styleVDs() { if (vdLayer && S.vdOn) vdLayer.setStyle(vdStyle); }

// ---------------------------------------------------------------- hex map
let hexSVG, hexTip;
function initHex() {
  const R = 10, sq3 = Math.sqrt(3);
  const pos = W.map((w) => [R * sq3 * (w.hex[0] + 0.5 * (w.hex[1] % 2)), R * 1.5 * w.hex[1]]);
  const xs = pos.map((p) => p[0]), ys = pos.map((p) => p[1]);
  const pad = R * 1.6;
  const vb = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) - Math.min(...xs) + 2 * pad, Math.max(...ys) - Math.min(...ys) + 2 * pad];
  const hexPath = (x, y) => {
    const pts = [];
    for (let a = 0; a < 6; a++) { const t = Math.PI / 180 * (60 * a - 30); pts.push((x + (R - 0.6) * Math.cos(t)).toFixed(2) + ',' + (y + (R - 0.6) * Math.sin(t)).toFixed(2)); }
    return 'M' + pts.join('L') + 'Z';
  };
  const el = $('#hex');
  el.innerHTML = `<svg viewBox="${vb.join(' ')}" role="img" aria-label="Equal-area ward map: each hexagon is one ward">
    ${W.map((w, i) => `<g class="hx" data-i="${i}" tabindex="0" role="button" aria-label="Ward ${w.no}"><path d="${hexPath(...pos[i])}" class="ward"></path><text x="${pos[i][0].toFixed(1)}" y="${(pos[i][1] + 2.6).toFixed(1)}" text-anchor="middle" font-size="7" font-weight="600" pointer-events="none">${w.no}</text></g>`).join('')}
  </svg>`;
  hexSVG = el.querySelector('svg');
  hexTip = document.createElement('div'); hexTip.className = 'hextt tt'; hexTip.hidden = true; el.appendChild(hexTip);
  el.addEventListener('mousemove', (e) => {
    const g = e.target.closest('.hx');
    if (!g) { hexTip.hidden = true; return; }
    hexTip.innerHTML = tipHTML(+g.dataset.i);
    hexTip.hidden = false;
    const r = el.getBoundingClientRect();
    let x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    if (x + 260 > r.width) x = e.clientX - r.left - 270;
    if (y + 140 > r.height) y = e.clientY - r.top - 150;
    hexTip.style.left = x + 'px'; hexTip.style.top = y + 'px';
  });
  el.addEventListener('mouseleave', () => { hexTip.hidden = true; });
  el.addEventListener('click', (e) => { const g = e.target.closest('.hx'); if (g) select(W[+g.dataset.i].id, false); });
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.hx')) { e.preventDefault(); select(W[+e.target.closest('.hx').dataset.i].id, false); } });
}
function styleHex() {
  if (!hexSVG) return;
  hexSVG.querySelectorAll('.hx').forEach((g) => {
    const i = +g.dataset.i, st = wardStyle(i), sel = S.sel === W[i].id;
    const p = g.firstElementChild, t = g.lastElementChild;
    p.setAttribute('fill', st.fill);
    p.setAttribute('stroke', sel ? C.ink : 'none');
    p.setAttribute('stroke-width', sel ? 1.6 : 0);
    t.setAttribute('fill', luminance(st.fill) > 0.6 ? '#17141f' : '#ffffff');
    g.classList.toggle('flash', S.changed.has(W[i].id));
  });
}

function restyle() {
  W.forEach((w, i) => styleWard(i));
  styleVDs();
  styleHex();
  if (S.changed.size) {
    W.forEach((w, i) => { if (S.changed.has(w.id) && layers[i] && layers[i]._path) { layers[i]._path.classList.remove('flash'); void layers[i]._path.offsetWidth; layers[i]._path.classList.add('flash'); } });
    setTimeout(() => S.changed.clear(), 2600);
  }
  renderLegend();
}

// ---------------------------------------------------------------- legend
function renderLegend() {
  const el = $('#legend');
  const cb = S.colorBy;
  const ramp = (cols) => `<div class="ramp">${cols.map((c) => `<span style="background:${c}"></span>`).join('')}</div>`;
  let h = '';
  if (cb === 'share' || cb === 'prob') {
    const cols = SEQ.map((t) => seqColour(pc(S.party), t));
    h = `<div class="t">${NAMES[S.party]} ${cb === 'prob' ? 'win chance' : 'vote share'}</div>${ramp(cols)}<div class="ends">${cb === 'prob' ? '<span>&lt;10%</span><span>50%</span><span>90%+</span>' : '<span>0%</span><span>25%</span><span>50%+</span>'}</div>`;
  } else if (cb === 'swing') {
    const cols = [mix(C.neg, C.mid, 1), mix(C.neg, C.mid, 0.66), mix(C.neg, C.mid, 0.33), C.mid, mix(C.pos, C.mid, 0.33), mix(C.pos, C.mid, 0.66), mix(C.pos, C.mid, 1)];
    h = `<div class="t">${NAMES[S.party]}: change in share (points)</div>${ramp(cols)}<div class="ends"><span>−15 loss</span><span>0</span><span>gain +15</span></div>`;
  } else if (cb === 'turnout') {
    h = `<div class="t">Turnout (valid votes ÷ registered)</div>${ramp(SEQ.map((t) => seqColour(C.accent, t)))}<div class="ends"><span>20%</span><span>45%</span><span>70%+</span></div>`;
  } else if (cb === 'progress') {
    h = `<div class="t">Voting districts counted</div>${ramp([mix(C.ink3, C.bg, 0.1), ...[0.25, 0.45, 0.65, 0.85, 1].map((t) => seqColour(C.ink, t))])}<div class="ends"><span>none</span><span>half</span><span>all</span></div>`;
  } else {
    const ks = new Set();
    W.forEach((w, i) => { const inf = wardInfo(i); if (inf) ks.add(G[cb === 'nowcast' && inf.est ? inf.estK : inf.k]); });
    const items = G.filter((g) => ks.has(g)).map((g) => `<span class="row" style="display:inline-flex;gap:5px;align-items:center"><span class="sw" style="background:${pc(g)}"></span>${NAMES[g]}</span>`).join('');
    const scale = S.mode === 'projection' || cb === 'nowcast' ? ['Toss-up', 'Lean', 'Likely', 'Safe'] : S.mode === 'live' ? ['Close', 'Leading', 'Clear', 'Won'] : ['<5', '5–15', '15–30', '30+ pts'];
    const strength = `<div class="ramp" style="width:180px">${STRENGTH.map((t) => `<span style="background:${mix(C.ink3, C.bg, t)}"></span>`).join('')}</div><div class="ends" style="width:180px">${scale.map((s) => `<span>${s}</span>`).join('')}</div>`;
    const title = S.mode === 'projection' ? 'Projected favourite · shade = confidence' : cb === 'nowcast' ? 'Projected winner · shade = confidence' : S.mode === 'live' ? 'Leading party · shade = how settled' : 'Winning party · shade = margin';
    h = `<div class="t">${title}</div><div class="items">${items}</div>${strength}`;
    if (S.mode === 'live' && (!S.live || !S.live.vdsCounted) && S.tl == null) h += '<div class="muted" style="margin-top:4px">No results yet: pale shading shows the poll projection.</div>';
  }
  el.innerHTML = h;
}

// ---------------------------------------------------------------- charts
function bars(rows, opts = {}) {
  // rows: [{g, v, ghost, prev, lo, hi, sub}]
  const max = Math.max(opts.max || 0, ...rows.map((r) => Math.max(r.v || 0, r.ghost || 0, r.prev || 0, r.hi || 0))) || 1;
  const sc = (x) => (100 * x) / max;
  return `<div class="bars">${rows.map((r) => `
    <div class="brow" title="${esc(FULL[r.g] || r.g)}">
      <span class="nm"><span class="sw" style="background:${pc(r.g)}"></span>${esc(SHORT[r.g] || r.g)}</span>
      <span class="btrack">
        <span class="bfill" style="width:${sc(r.v || 0)}%;background:${pc(r.g)}"></span>
        ${r.lo != null ? `<span class="bci" style="left:${sc(r.lo)}%;width:${Math.max(0.5, sc(r.hi - r.lo))}%"></span>` : ''}
        ${r.prev != null ? `<span class="bprev" style="left:${sc(r.prev)}%" title="Previous: ${pct(r.prev)}"></span>` : ''}
        ${r.ghost != null ? `<span class="bghost" style="left:calc(${sc(r.ghost)}% - 1px)" title="Projected final: ${pct(r.ghost)}"></span>` : ''}
      </span>
      <span class="val">${pct(r.v)}${r.sub ? `<small>${r.sub}</small>` : ''}</span>
    </div>`).join('')}</div>`;
}

function hemicycle(seats, total = 214) {
  // parliament arc: rows of seats, filled left to right in SEAT_ORDER
  const rows = 9, r0 = 46, r1 = 104;
  const radii = Array.from({ length: rows }, (_, i) => r0 + (i * (r1 - r0)) / (rows - 1));
  const tot = sum(radii);
  let counts = radii.map((r) => Math.round((total * r) / tot));
  let diff = total - sum(counts); counts[counts.length - 1] += diff;
  const pts = [];
  radii.forEach((r, i) => {
    const n = counts[i];
    for (let j = 0; j < n; j++) {
      const a = Math.PI - (Math.PI * j) / (n - 1);
      pts.push({ a, x: 110 + r * Math.cos(a), y: 108 - r * Math.sin(a) });
    }
  });
  pts.sort((p, q) => q.a - p.a);
  const colours = [];
  for (const g of SEAT_ORDER) for (let s = 0; s < (seats[GI[g]] || 0); s++) colours.push(g);
  const dotR = 3.0;
  return `<svg class="hemi" viewBox="0 -4 220 116" role="img" aria-label="Council seats: ${SEAT_ORDER.filter((g) => seats[GI[g]]).map((g) => `${NAMES[g]} ${seats[GI[g]]}`).join(', ')}">
    ${pts.map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${dotR}" fill="${colours[i] ? pc(colours[i]) : C.line}"><title>${colours[i] ? NAMES[colours[i]] : 'Unallocated'}</title></circle>`).join('')}
    <line x1="110" y1="0" x2="110" y2="${108 - r0 + 6}" stroke="${C.ink}" stroke-width="0.8" stroke-dasharray="2 2"></line>
    <text x="110" y="96" text-anchor="middle" font-size="22" font-weight="700" fill="${C.ink}" font-family="Barlow Condensed, sans-serif">${MAJORITY}</text>
    <text x="110" y="106" text-anchor="middle" font-size="6.5" fill="${C.ink3}">for a majority of ${total}</text>
  </svg>`;
}

function coalitionBox(seats, sims) {
  const sel = [...S.coalition];
  const tot = sum(sel.map((g) => seats[GI[g]] || 0));
  let prob = '';
  if (sims && sims.length) {
    const ks = sel.map((g) => GI[g]);
    const p = sims.filter((s) => ks.reduce((a, k) => a + s[k], 0) >= MAJORITY).length / sims.length;
    prob = ` · <b>${pp(p)}</b> chance of ${MAJORITY}+`;
  }
  const chips = SEAT_ORDER.slice().sort((a, b) => (seats[GI[b]] || 0) - (seats[GI[a]] || 0)).filter((g) => seats[GI[g]] > 0)
    .map((g) => `<button class="chip" data-coal="${g}" aria-pressed="${S.coalition.has(g)}"><span class="sw" style="background:${pc(g)}"></span>${NAMES[g]} <small>${seats[GI[g]]}</small></button>`).join('');
  return `<div class="seatlist" role="group" aria-label="Pick parties for a coalition">${chips}</div>
    <div class="coal"><span class="big">${tot}</span><span>${sel.length ? sel.map((g) => NAMES[g]).join(' + ') : 'Pick parties above'}<br>
      <span class="${tot >= MAJORITY ? 'ok' : 'muted'}">${tot >= MAJORITY ? 'Majority' : `${MAJORITY - tot} short of a majority`}</span>${prob}</span></div>
    <div class="presets">${PRESETS.map((p, i) => `<button data-preset="${i}">${esc(p.name)}</button>`).join('')}</div>`;
}

function wardStrip(ks) {
  const cnt = new Array(K).fill(0); ks.forEach((k) => { if (k != null) cnt[k]++; });
  const pend = ks.filter((k) => k == null).length;
  const ord = order(cnt).filter(([, c]) => c > 0);
  return `<div class="wardstrip" role="img" aria-label="${ord.map(([k, c]) => `${NAMES[G[k]]} ${c}`).join(', ')}">
    ${ord.map(([k, c]) => `<span style="flex:${c};background:${pc(G[k])}" title="${NAMES[G[k]]}: ${c} wards"></span>`).join('')}
    ${pend ? `<span style="flex:${pend};background:${C.line}" title="Not yet counted: ${pend}"></span>` : ''}
  </div>
  <div class="wardstrip-l">${ord.map(([k, c]) => `<span><span class="sw" style="background:${pc(G[k])}"></span> ${NAMES[G[k]]} <b>${c}</b></span>`).join('')}${pend ? `<span class="muted">Awaiting ${pend}</span>` : ''}</div>`;
}

function slopeChart(w) {
  // party share across elections in this ward
  const cols = [['lge2016_ward', '2016'], ['lge2021_ward', '2021'], ['npe2024', '2024 nat.'], ['proj', '2026 proj.']];
  const i = WI[w.id];
  const lw = liveWard(w.id);
  if (lw && lw.n) cols.push(['live', lw.n >= (lw.N || w.nvd) ? '2026' : '2026 so far']);
  const val = (c) => {
    if (c === 'proj') return S.proj.P[i];
    if (c === 'live') return shares(lw.v);
    const h = w.h[c]; return h ? shares(h.v) : null;
  };
  const data = cols.map(([c]) => val(c));
  const show = G.filter((g, k) => data.some((d) => d && d[k] >= 0.04) && g !== 'OTH');
  const Wd = 340, H = 170, pl = 8, pr = 58, pt = 10, pb = 22;
  const x = (j) => pl + (j * (Wd - pl - pr)) / (cols.length - 1);
  const maxv = Math.max(0.5, ...data.flatMap((d) => (d ? show.map((g) => d[GI[g]]) : [])));
  const y = (v) => pt + (1 - v / maxv) * (H - pt - pb);
  const grid = [0, 0.25, 0.5, 0.75].filter((v) => v <= maxv).map((v) => `<line x1="${pl}" x2="${Wd - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}" stroke-width="1"></line>${v ? `<text x="${pl + 2}" y="${y(v) - 3}" font-size="9" fill="${C.ink3}">${v * 100}%</text>` : ''}`).join('');
  const labelsY = [];
  const lines = show.map((g) => {
    const k = GI[g];
    const pts = data.map((d, j) => (d ? [x(j), y(d[k])] : null)).filter(Boolean);
    if (!pts.length) return '';
    const last = pts[pts.length - 1];
    labelsY.push({ g, y: last[1] });
    return `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${pc(g)}" stroke-width="2" stroke-linejoin="round"></polyline>` +
      pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="${pc(g)}" stroke="${C.surface}" stroke-width="1.5"></circle>`).join('');
  }).join('');
  labelsY.sort((a, b) => a.y - b.y);
  spread(labelsY, 11, pt, H - pb - 4);
  const lbls = labelsY.map((l) => `<text x="${x(cols.length - 1) + 7}" y="${l.y + 3}" font-size="9.5" font-weight="600" fill="${C.ink}">${NAMES[l.g]}</text>`).join('');
  const xl = cols.map(([, t], j) => `<text x="${x(j)}" y="${H - 6}" font-size="9.5" text-anchor="middle" fill="${C.ink3}">${t}</text>`).join('');
  return `<svg class="slope" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Party shares in ward ${w.no} across elections">${grid}${lines}${lbls}${xl}</svg>`;
}

function spread(items, gap, lo, hi) {
  // push labels apart (sorted by y), then pull back inside [lo, hi]
  for (let j = 1; j < items.length; j++) if (items[j].y - items[j - 1].y < gap) items[j].y = items[j - 1].y + gap;
  if (items.length && items[items.length - 1].y > hi) {
    items[items.length - 1].y = hi;
    for (let j = items.length - 2; j >= 0; j--) if (items[j + 1].y - items[j].y < gap) items[j].y = items[j + 1].y - gap;
  }
  if (items.length && items[0].y < lo) items[0].y = lo;
}
function pollChart() {
  const ps = S.st.polls;
  const parties = ['DA', 'ANC', 'EFF', 'ASA', 'FFP', 'MK'];
  const t0 = Date.parse('2026-02-15'), t1 = Date.parse(S.st.electionDay);
  const Wd = 340, H = 170, pl = 28, pr = 68, pt = 8, pb = 20;
  const x = (t) => pl + ((t - t0) / (t1 - t0)) * (Wd - pl - pr);
  const y = (v) => pt + (1 - v / 50) * (H - pt - pb);
  const grid = [0, 10, 20, 30, 40, 50].map((v) => `<line x1="${pl}" x2="${Wd - pr}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}"></line><text x="${pl - 4}" y="${y(v) + 3}" font-size="9" text-anchor="end" fill="${C.ink3}">${v}</text>`).join('');
  const months = ['2026-03-01', '2026-05-01', '2026-07-01', '2026-09-01', '2026-11-01'].map((d) => `<text x="${x(Date.parse(d))}" y="${H - 5}" font-size="9" text-anchor="middle" fill="${C.ink3}">${new Date(d).toLocaleString('en-ZA', { month: 'short' })}</text>`).join('');
  const dots = ps.flatMap((p) => parties.filter((g) => p.s[g] != null).map((g) => `<circle cx="${x(Date.parse(p.fieldwork_end)).toFixed(1)}" cy="${y(p.s[g]).toFixed(1)}" r="${2 + Math.sqrt(p.n) / 14}" fill="${pc(g)}" fill-opacity=".55" stroke="${pc(g)}"><title>${p.pollster} (${p.sponsor}), ${p.fieldwork_end}: ${NAMES[g]} ${p.s[g]}%</title></circle>`)).join('');
  const T = S.proj.T;
  const ends = parties.map((g) => ({ g, y: y(T[GI[g]] * 100) })).sort((a, b) => a.y - b.y);
  spread(ends, 11, pt, H - pb - 2);
  const avg = ends.map((e) => `<line x1="${x(t1) - 6}" x2="${x(t1)}" y1="${y(T[GI[e.g]] * 100)}" y2="${y(T[GI[e.g]] * 100)}" stroke="${pc(e.g)}" stroke-width="3"></line><text x="${x(t1) + 4}" y="${e.y + 3}" font-size="9.5" font-weight="600" fill="${C.ink}">${NAMES[e.g]} ${(T[GI[e.g]] * 100).toFixed(0)}</text>`).join('');
  return `<svg class="pollchart" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Tshwane polls in 2026 and the average used">${grid}${months}${dots}${avg}</svg>`;
}

// ---------------------------------------------------------------- rail
function render() {
  const rail = $('#rail');
  let h = '';
  if (S.sel) h += wardSection();
  if (S.mode === 'live') h += liveSections();
  else if (S.mode === 'projection') h += projSections();
  else h += resultSections();
  h += footer();
  const scroll = rail.scrollTop;
  rail.innerHTML = h;
  rail.scrollTop = scroll;
  renderStatus();
  themeLabel();
}

function renderStatus() {
  const L = S.live;
  let h = '';
  if (S.rehearsal) h = `<span class="pill sim">Rehearsal</span>`;
  else if (!L || L.status === 'pre' || !L.vdsCounted) h = `<span class="pill">Awaiting results</span>`;
  else if (L.status === 'final') h = `<span class="pill final">Count complete</span>`;
  else h = `<span class="pill live">Counting</span>`;
  if (L && L.vdsCounted) h += `<span class="num">${pct(L.vdsCounted / (L.vdsTotal || 1), 0)} of VDs</span>`;
  if (L && L.updated) h += `<span class="when">Updated ${timeSAST(L.updated)} SAST</span>`;
  else if (L && L.fetched) h += `<span class="when">Checked ${timeSAST(L.fetched)}</span>`;
  $('#status').innerHTML = h;
}

function wardSection() {
  const w = W[WI[S.sel]], i = WI[S.sel];
  const inf = wardInfo(i) || {};
  const h21 = w.h.lge2021_ward;
  const prev = h21 ? winner(shares(h21.v)) : null;
  const lw = liveWard(w.id);
  let call = '';
  if (S.mode === 'live') {
    if (inf.status === 'awaiting') call = callBox(G[inf.k], `Not counted yet`, `Projection: ${ratingLabel(inf.wp[inf.k])} ${NAMES[G[inf.k]]} (${pp(inf.wp[inf.k])}). ${w.nvd} voting districts to report.`, 0.35);
    else {
      const g = G[inf.k];
      const verb = inf.status === 'complete' ? 'wins' : inf.safe ? 'set to win' : 'leads';
      const flip = prev && prev.k !== inf.k ? ` · gain from ${NAMES[G[prev.k]]}` : prev ? ' · hold' : '';
      const why = `${inf.status === 'complete' ? 'All' : `${inf.n} of`} ${inf.N} VDs counted · lead ${int((inf.s - inf.s2) * inf.votes)} votes (${fmt((inf.s - inf.s2) * 100)} pts)` +
        (inf.est && inf.status !== 'complete' ? ` · ${pp(inf.prob)} to win` : '');
      call = callBox(g, `${NAMES[g]} ${verb}${inf.status === 'complete' || inf.safe ? flip : ''}`, why, 1);
    }
  } else if (S.mode === 'projection') {
    const g = G[inf.k];
    const flip = prev && prev.k !== inf.k ? ` · would gain from ${NAMES[G[prev.k]]}` : '';
    call = callBox(g, `${ratingLabel(inf.prob)} ${NAMES[g]}${flip}`, `${pp(inf.prob)} win chance in ${N_SIMS.toLocaleString()} simulations · projected margin ${fmt(inf.margin * 100)} pts`, STRENGTH[strengthOfProb(inf.prob)]);
  } else if (inf.sh) {
    const g = G[inf.k];
    call = callBox(g, `${NAMES[g]} won`, `${S.st.elections[S.past].label} · margin ${fmt(inf.margin * 100)} pts over ${NAMES[G[inf.k2]]}${inf.cov < 0.999 ? ` · ${pct(inf.cov, 0)} of today's VDs existed then` : ''}`, 1);
  }
  const prevSh = h21 ? shares(h21.v) : null;
  const rows = order(inf.est && S.mode === 'live' ? inf.est : inf.sh || []).slice(0, 7).map(([k, v]) => ({
    g: G[k], v: S.mode === 'live' && inf.sh ? inf.sh[k] : v,
    ghost: S.mode === 'live' && inf.est && inf.status === 'counting' ? inf.est[k] : null,
    prev: S.mode !== 'results' || S.past !== 'lge2021_ward' ? (prevSh ? prevSh[k] : null) : null,
  }));
  const reg = lw && lw.reg ? lw.reg : h21 ? h21.reg : null;
  const turnout = S.mode === 'live' && inf.votes && lw && lw.reg ? inf.votes / lw.reg : S.mode === 'results' && inf.reg ? inf.votes / inf.reg : null;
  let detail = '';
  const topList = S.mode === 'live' && lw && lw.top && lw.top.length ? lw.top : (w.h[S.mode === 'results' ? S.past : 'lge2021_ward'] || {}).top;
  if (topList && topList.length) {
    const tot = S.mode === 'live' && lw && lw.top ? sum(lw.v) : sum((w.h[S.mode === 'results' ? S.past : 'lge2021_ward'] || { v: [1] }).v);
    detail = `<details><summary>All parties on the ${S.mode === 'live' && lw && lw.top ? '2026' : (S.mode === 'results' ? S.st.elections[S.past].short : '2021')} ward ballot</summary>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Party</th><th class="r">Votes</th><th class="r">Share</th></tr></thead><tbody>
      ${topList.map(([p, v]) => `<tr><td>${esc(titleCase(p))}</td><td class="r">${int(v)}</td><td class="r">${pct(v / tot)}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  let vdTable = '';
  if (S.mode === 'live' && S.live && S.live.vd) {
    const vds = S.st.vds.filter((v) => v[1] === i);
    vdTable = `<details${inf.status === 'counting' ? ' open' : ''}><summary>Voting districts (${vds.length})</summary><div class="tbl-wrap"><table class="t"><thead><tr><th>VD</th><th>Status</th><th>Leader</th><th class="r">Votes</th></tr></thead><tbody>
      ${vds.map(([vd]) => {
        const v = S.tl == null ? S.live.vd[vd] : null;
        if (!v || !sum(v)) return `<tr><td>${vd}${vdName(vd)}</td><td class="muted">Not counted</td><td></td><td></td></tr>`;
        const wn = winner(shares(v));
        return `<tr><td>${vd}${vdName(vd)}</td><td>Counted</td><td><span class="sw" style="background:${pc(G[wn.k])}"></span> ${NAMES[G[wn.k]]} ${pct(wn.s, 0)}</td><td class="r">${int(sum(v))}</td></tr>`;
      }).join('')}</tbody></table></div></details>`;
  }
  return `<section class="sec" aria-label="Ward ${w.no}">
    <div class="wardhead"><span class="wn">${w.no}</span>
      <div class="meta"><span class="eyebrow">Ward ${w.no} · ${esc(w.id)}</span>
        <span>${fmt(w.km2, w.km2 < 10 ? 1 : 0)} km² · ${w.nvd} voting districts${w.cands ? ` · ${w.cands} candidates` : ''}</span>
        ${w.places && w.places.length ? `<span>${esc(w.places.slice(0, 6).join(', '))}</span>` : ''}</div>
      <button class="iconbtn x" id="closeward" aria-label="Close ward details">✕</button></div>
    ${call}
    ${rows.length ? bars(rows) : ''}
    ${rows.length ? `<p class="note">${S.mode === 'live' && inf.est && inf.status === 'counting' ? 'Bars: counted so far. <b>Tick</b>: projected final. ' : ''}${rows.some((r) => r.prev != null) ? '<b>Dotted line</b>: 2021 ward ballot on today’s boundaries.' : ''}</p>` : ''}
    <div class="kv">
      <div><b>${int(reg)}</b><span>Registered${lw && lw.reg ? '' : ' (2021)'}</span></div>
      <div><b>${turnout ? pct(turnout, 0) : h21 ? pct(sum(h21.v) / h21.reg, 0) : '–'}</b><span>Turnout${turnout ? '' : ' 2021'}</span></div>
      <div><b>${prev ? NAMES[G[prev.k]] : '–'}</b><span>2021 winner</span></div>
    </div>
    <h3>Party shares over time</h3>
    ${slopeChart(w)}
    ${detail}${vdTable}
  </section>`;
}
function vdName(vd) { const n = S.st.vdNames && S.st.vdNames[vd]; return n ? `<br><span class="muted">${esc(titleCase(n))}</span>` : ''; }
function groupName(n) { const r = (S.st.city.lge2021_pr.all || []).concat(S.st.city.lge2016_pr.all || []).find((x) => x[0] === n); return r ? r[1] : 'OTH'; }
function titleCase(s) { return String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Of|And|The|For)\b/g, (m) => m.toLowerCase()).replace(/\bActionsa\b/, 'ActionSA').replace(/\bAnc\b/, 'ANC'); }
function callBox(g, what, why, strength) {
  return `<div class="callbox"><span class="sw" style="background:${mix(pc(g), C.surface, strength)}"></span><div><div class="what">${esc(what)}</div><div class="why">${esc(why)}</div></div></div>`;
}

function liveSections() {
  const L = S.tl != null && S.hist[S.tl] ? histLive(S.hist[S.tl]) : S.live;
  const total = (S.live && S.live.vdsTotal) || S.st.vds.length;
  const counted = L ? L.vdsCounted : 0;
  let h = '';
  if (!counted) {
    const err = S.live && S.live.error && !S.rehearsal ? `<p class="note">Last check: ${esc(S.live.error)}${S.live.fetched ? ` (${timeSAST(S.live.fetched, true)})` : ''}.</p>` : '';
    h += `<section class="sec"><h2>Live count</h2>
      <p class="note">Polls close at <b>21:00 on Wednesday 4 November</b>. The IEC publishes results per voting district as each one is captured; this page checks every minute and updates the map as Tshwane's ${total} voting districts report.</p>
      <div class="progress"><div class="track"><div class="fill" style="width:0%"></div></div><div class="meta"><span>0 of ${total} voting districts</span><span>0%</span></div></div>
      ${err}
      <div class="btnrow"><button class="btn" id="rehearse">Run a rehearsal count</button></div>
      <p class="note">A rehearsal replays a <b>simulated</b> count, built from the projection with random error, so you can see how the live view behaves. It is not a result.</p>
    </section>`;
    h += projSummary(true);
    return h;
  }
  const cityW = L.city.ward, tv = sum(cityW);
  const sh = shares(cityW);
  const nc = S.tl == null ? S.now : null;
  const prev = shares(S.st.city.lge2021_ward.v);
  const lws = W.map((w) => (L.wards[w.id] && L.wards[w.id].n ? L.wards[w.id] : null));
  const complete = lws.filter((x, i) => x && x.n >= (x.N || W[i].nvd)).length;
  h += `<section class="sec"><h2>Live count <span class="aside">${S.rehearsal ? 'Simulated' : 'IEC'} · ${timeSAST(L.updated, true)}</span></h2>
    <div class="progress"><div class="track"><div class="fill" style="width:${(100 * counted) / total}%"></div></div>
      <div class="meta"><span><b>${counted}</b> of ${total} voting districts</span><span>${pct(counted / total, 0)}</span></div></div>
    <div class="kv">
      <div><b>${int(tv)}</b><span>Ward votes</span></div>
      <div><b>${lws.filter(Boolean).length}</b><span>Wards reporting</span></div>
      <div><b>${complete}</b><span>Wards complete</span></div>
    </div>
  </section>`;
  const rows = order(sh).filter(([k, v]) => v > 0.004 || (nc && nc.city[k] > 0.004)).slice(0, 8).map(([k, v]) => ({
    g: G[k], v, ghost: nc ? nc.city[k] : null, prev: prev[k], sub: int(cityW[k]),
  }));
  h += `<section class="sec"><h2>Vote share <span class="aside">ward ballot, counted</span></h2>${bars(rows)}
    <p class="note">${nc ? '<b>Tick</b>: projected final if uncounted districts swing like the counted ones. ' : ''}<b>Dotted line</b>: 2021.</p></section>`;
  if (nc) {
    const seats = nc.central.seats;
    h += `<section class="sec"><h2>Projected council <span class="aside">nowcast · 80% range</span></h2>${hemicycle(seats)}
      ${coalitionBox(seats, nc.seatSims)}
      <p class="note">Seats use the Municipal Structures Act formula on projected ward and PR votes. Ranges: ${SEAT_ORDER.filter((g) => seats[GI[g]] >= 3).sort((a, b) => seats[GI[b]] - seats[GI[a]]).map((g) => `${NAMES[g]} ${nc.seatQ[GI[g]].lo}–${nc.seatQ[GI[g]].hi}`).join(', ')}.</p></section>`;
  }
  const lead = W.map((w, i) => { const x = lws[i]; return x ? winner(shares(x.v)).k : null; });
  const flips = W.map((w, i) => {
    const x = lws[i]; const h21 = w.h.lge2021_ward;
    if (!x || !h21) return null;
    const a = winner(shares(x.v)).k, b = winner(shares(h21.v)).k;
    return a !== b ? { w, from: b, to: a, done: x.n >= (x.N || w.nvd) } : null;
  }).filter(Boolean);
  h += `<section class="sec"><h2>Wards <span class="aside">leading or won</span></h2>${wardStrip(lead)}
    ${flips.length ? `<h3>Changing hands vs 2021 (${flips.length})</h3><div class="tbl-wrap"><table class="t"><tbody>${flips.slice(0, 30).map((f) => `<tr class="click" data-ward="${f.w.id}"><td>Ward ${f.w.no}</td><td><span class="sw" style="background:${pc(G[f.to])}"></span> ${NAMES[G[f.to]]} ${f.done ? 'gain' : 'ahead'}</td><td class="muted">from ${NAMES[G[f.from]]}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">No ward is changing hands from 2021 so far.</p>'}
  </section>`;
  h += feedSection();
  return h;
}

function feedSection() {
  if (S.hist.length < 2) return '';
  const items = [];
  const lim = S.tl != null ? S.tl : S.hist.length - 1;
  for (let j = Math.max(1, lim - 40); j <= lim; j++) {
    const a = S.hist[j - 1].w || {}, b = S.hist[j].w || {};
    for (const [id, arr] of Object.entries(b)) {
      const w = W[WI[id]]; if (!w) continue;
      const old = a[id];
      const nw = winner(shares(arr.slice(1))).k;
      if (!old) items.push({ t: S.hist[j].t, txt: `Ward ${w.no}: first results, ${NAMES[G[nw]]} ahead`, id });
      else {
        const ow = winner(shares(old.slice(1))).k;
        if (arr[0] >= w.nvd && old[0] < w.nvd) items.push({ t: S.hist[j].t, txt: `Ward ${w.no} complete: ${NAMES[G[nw]]} wins`, id });
        else if (ow !== nw) items.push({ t: S.hist[j].t, txt: `Ward ${w.no}: ${NAMES[G[nw]]} overtakes ${NAMES[G[ow]]}`, id });
      }
    }
  }
  if (!items.length) return '';
  return `<section class="sec"><h2>Latest</h2><div class="feed">${items.reverse().slice(0, 40).map((it) => `<div class="it"><time>${timeSAST(it.t)}</time><a href="#" data-ward="${it.id}">${esc(it.txt)}</a></div>`).join('')}</div></section>`;
}

function projSummary(compact) {
  const p = S.proj;
  const prev = shares(S.st.city.lge2021_ward.v);
  const rows = order(p.T).filter(([, v]) => v > 0.004).slice(0, 8).map(([k, v]) => ({ g: G[k], v, lo: p.shareQ[k].lo, hi: p.shareQ[k].hi, prev: prev[k] }));
  const seats = G.map((g, k) => p.seatQ[k].med);
  // keep medians summing to 214 for the arc
  const c = p.central.seats;
  let h = `<section class="sec"><h2>${compact ? 'Pre-election projection' : 'Projected vote share'} <span class="aside">80% range</span></h2>${bars(rows)}
    <p class="note">Poll average applied ward by ward to 2021/2024 results. <b>Whisker</b>: 80% range from ${N_SIMS.toLocaleString()} simulations. <b>Dotted line</b>: 2021.</p></section>`;
  h += `<section class="sec"><h2>Projected council</h2>${hemicycle(c)}${coalitionBox(c, p.seatSims)}
    <p class="note">Largest party: ${order(p.largest).filter(([, x]) => x > 0.01).map(([k, x]) => `${NAMES[G[k]]} ${pp(x)}`).join(', ')}. Seat ranges (80%): ${SEAT_ORDER.filter((g) => seats[GI[g]] >= 3).sort((a, b) => seats[GI[b]] - seats[GI[a]]).map((g) => `${NAMES[g]} ${p.seatQ[GI[g]].lo}–${p.seatQ[GI[g]].hi}`).join(', ')}.</p></section>`;
  if (!compact) {
    const fav = W.map((w, i) => winner(p.P[i]).k);
    const rat = { Safe: 0, Likely: 0, Lean: 0, 'Toss-up': 0 };
    W.forEach((w, i) => { rat[ratingLabel(p.winProb[i][fav[i]])]++; });
    const close = W.map((w, i) => ({ w, i, p: p.winProb[i][fav[i]] })).sort((a, b) => a.p - b.p).slice(0, 12);
    const flips = W.filter((w, i) => w.h.lge2021_ward && winner(shares(w.h.lge2021_ward.v)).k !== fav[i]).length;
    h += `<section class="sec"><h2>Ward outlook <span class="aside">${flips} projected to change hands</span></h2>${wardStrip(fav)}
      <p class="note">${Object.entries(rat).map(([r, n]) => `${r} <b>${n}</b>`).join(' · ')}</p>
      <h3>Closest wards</h3><div class="tbl-wrap"><table class="t"><thead><tr><th>Ward</th><th>Favourite</th><th class="r">Chance</th><th>2021</th></tr></thead><tbody>
      ${close.map(({ w, i }) => { const f = fav[i], h21 = w.h.lge2021_ward ? winner(shares(w.h.lge2021_ward.v)).k : null;
        return `<tr class="click" data-ward="${w.id}"><td>Ward ${w.no}</td><td><span class="sw" style="background:${pc(G[f])}"></span> ${NAMES[G[f]]}</td><td class="r">${pp(p.winProb[i][f])}</td><td class="muted">${h21 != null ? NAMES[G[h21]] : '–'}</td></tr>`; }).join('')}
      </tbody></table></div></section>`;
  }
  return h;
}

function projSections() {
  let h = '';
  h += `<section class="sec"><h2>Polls <span class="aside">${S.st.polls.length} Tshwane polls in 2026</span></h2>${pollChart()}
    <p class="note">Each dot is one poll (bigger = larger sample). Bars on the right: the average the projection uses, weighted by recency (30-day half-life) and sample size.</p>
    <details><summary>Poll list and sources</summary><div class="polls">${S.st.polls.map((p) => `<div class="poll"><span class="who">${esc(p.pollster)} <span class="muted">for ${esc(p.sponsor)}</span></span><span class="w">n=${p.n}</span>
      <span class="when">Fieldwork to ${esc(p.fieldwork_end)} · ${esc(p.source)}${p.note ? ' · ' + esc(p.note) : ''}</span><span></span>
      <span class="mini">${POLLED.filter((g) => p.s[g]).map((g) => `<span style="flex:${p.s[g]};background:${pc(g)}" title="${NAMES[g]} ${p.s[g]}%"></span>`).join('')}<span style="flex:${Math.max(0, 100 - sum(Object.values(p.s)))};background:${C.line}"></span></span></div>`).join('')}</div></details>
  </section>`;
  const T = S.proj.T;
  h += `<section class="sec"><h2>What if? <span class="aside">${S.override ? 'Your scenario' : 'Poll average'}</span></h2>
    <div class="sliders">${POLLED.map((g) => `<div class="sl"><label for="sl-${g}"><span class="sw" style="background:${pc(g)}"></span>${NAMES[g]}</label>
      <input type="range" id="sl-${g}" data-party="${g}" min="0" max="60" step="0.5" value="${(T[GI[g]] * 100).toFixed(1)}" style="--c:${pc(g)};--v:${(T[GI[g]] * 100 / 60 * 100).toFixed(1)}%"><output>${(T[GI[g]] * 100).toFixed(1)}</output></div>`).join('')}</div>
    <p class="note">Drag to set city-wide shares; every ward, the seat count and the odds update. Small parties and independents take what is left${S.override ? ` (${fmt(100 - sum(POLLED.map((g) => S.override[g] || 0)))}%)` : ''}.</p>
    ${S.override ? '<div class="btnrow"><button class="btn ghost" id="resetpolls">Back to poll average</button></div>' : ''}
  </section>`;
  h += projSummary(false);
  h += `<section class="sec"><details><summary>How the projection works</summary>
    <ul><li>Every 2026 ward's starting point is its 2021 ward-ballot result (65%) blended with its 2024 national-ballot result (35%), both re-added from the voting districts that make up the ward today.</li>
    <li>Party shares are then scaled ward by ward until the city total matches the poll average (iterative proportional fitting, which keeps each ward's relative strengths).</li>
    <li>${N_SIMS.toLocaleString()} simulations add a city-wide error per party (poll spread plus 2 points) and a ward-level error (about 20%), giving win chances and seat ranges.</li>
    <li>Seats follow the Municipal Structures Act: quota and largest remainder on combined ward and PR votes, ward seats first. Majority is ${MAJORITY} of 214.</li>
    <li>Limits: local candidates, independents and turnout differences are not modelled; Tshwane polls have small samples (158–1,046).</li></ul></details></section>`;
  return h;
}

function resultSections() {
  const e = S.past, el = S.st.elections[e];
  const ct = S.st.city[e];
  const sh = shares(ct.v);
  const prevE = { lge2021_ward: 'lge2016_ward', lge2021_pr: 'lge2016_pr', npe2024: 'lge2021_ward' }[e];
  const prev = prevE ? shares(S.st.city[prevE].v) : null;
  const rows = order(sh).filter(([, v]) => v > 0.004).slice(0, 8).map(([k, v]) => ({ g: G[k], v, prev: prev ? prev[k] : null, sub: int(ct.v[k]) }));
  let h = `<section class="sec"><h2>${esc(el.label)}</h2>
    <div class="kv"><div><b>${int(sum(ct.v))}</b><span>Valid votes</span></div><div><b>${int(ct.reg)}</b><span>Registered</span></div><div><b>${pct(sum(ct.v) / ct.reg, 0)}</b><span>Turnout</span></div></div>
    ${bars(rows)}${prev ? `<p class="note"><b>Dotted line</b>: ${S.st.elections[prevE].label}.</p>` : ''}</section>`;
  if (e.startsWith('lge')) {
    const yr = e.slice(3, 7);
    const wins = new Array(K).fill(0);
    W.forEach((w) => { const hh = w.h[`lge${yr}_ward`]; if (hh) wins[winner(shares(hh.v)).k]++; });
    const named = allocateNamed(S.st.city[`lge${yr}_ward`].all || [], S.st.city[`lge${yr}_pr`].all || [], wins);
    const seats = named.groups;
    h += `<section class="sec"><h2>Council ${yr} <span class="aside">from ward + PR votes</span></h2>${hemicycle(seats)}${coalitionBox(seats)}
      <p class="note">Seats recomputed from the IEC vote totals with the Municipal Structures Act formula. ${named.named.filter(([n]) => !['ANC','DA','EFF','ASA','FFP','PA','ACDP','MK'].includes(groupName(n))).map(([n, x]) => `${esc(titleCase(n))} ${x}`).join(', ')}${yr === '2016' ? '. The 2016 council also had 214 seats.' : '.'}</p></section>`;
    const lead = W.map((w) => (w.h[`lge${yr}_ward`] ? winner(shares(w.h[`lge${yr}_ward`].v)).k : null));
    h += `<section class="sec"><h2>Wards <span class="aside">on 2026 boundaries</span></h2>${wardStrip(lead)}
      <p class="note">Results re-added inside today's 107 wards voting district by voting district. Where a district is new since ${yr}, the ward's figures cover the districts that existed then.</p></section>`;
  } else {
    const lead = W.map((w) => (w.h[e] ? winner(shares(w.h[e].v)).k : null));
    h += `<section class="sec"><h2>Wards <span class="aside">who topped each ward</span></h2>${wardStrip(lead)}
      <p class="note">National ballot, 29 May 2024, counted inside today's ward boundaries. A guide to party strength, not a local result.</p></section>`;
  }
  return h;
}

function footer() {
  return `<footer class="foot">
    <div>Sources: <a href="https://results.elections.org.za/" target="_blank" rel="noopener">IEC results</a> (per voting district), <a href="https://spatialhub-mdb-sa.opendata.arcgis.com/" target="_blank" rel="noopener">Municipal Demarcation Board</a> 2026 wards, Tshwane polls by Ipsos, SRF/The Common Sense, MarkData/eNCA and SABI/News24. Not affiliated with the IEC or any party.</div>
    <div>Data built ${esc(S.st.generated.slice(0, 10))}. Projection and nowcast are statistical estimates; only the IEC declares results.</div>
    <div class="btnrow"><button class="iconbtn" id="theme">Theme: <span id="themelbl"></span></button></div>
  </footer>`;
}

// ---------------------------------------------------------------- controls
function setMode(m, push = true) {
  S.mode = m;
  S.tl = null;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
  $('#pastctrl').hidden = m !== 'results';
  const modes = colourModes();
  if (!modes.some(([v]) => v === S.colorBy)) S.colorBy = modes[0][0];
  $('#colorby').innerHTML = modes.map(([v, t]) => `<option value="${v}"${v === S.colorBy ? ' selected' : ''}>${t}</option>`).join('');
  partyCtrl();
  timelineUI();
  if (push) writeHash();
  restyle(); render();
}
function partyCtrl() { $('#partyctrl').hidden = !['share', 'swing', 'prob'].includes(S.colorBy); }

function select(id, fly) {
  S.sel = id;
  writeHash();
  restyle(); render();
  $('#rail').scrollTop = 0;
  if (fly && S.view === 'geo' && layers[WI[id]]) map.fitBounds(layers[WI[id]].getBounds(), { maxZoom: 13, padding: [40, 40] });
  if (window.matchMedia('(max-width: 860px)').matches) $('#rail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function writeHash() {
  const h = S.mode + (S.sel ? '-w' + W[WI[S.sel]].no : '');
  if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h);
}
function readHash() {
  const m = /^(live|projection|results)(?:-w(\d+))?$/.exec(location.hash.slice(1));
  if (!m) return false;
  S.mode = m[1];
  if (m[2]) { const w = W.find((x) => x.no === +m[2]); if (w) S.sel = w.id; }
  return true;
}

function bind() {
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('#past').addEventListener('change', (e) => { S.past = e.target.value; restyle(); render(); });
  $('#colorby').addEventListener('change', (e) => { S.colorBy = e.target.value; partyCtrl(); restyle(); });
  $('#party').addEventListener('change', (e) => { S.party = e.target.value; restyle(); });
  $('#v-geo').addEventListener('click', () => setView('geo'));
  $('#v-hex').addEventListener('click', () => setView('hex'));
  $('#l-w').addEventListener('click', () => toggleVDs(false));
  $('#l-vd').addEventListener('click', () => toggleVDs(true));
  $('#b-on').addEventListener('click', () => { S.base = true; baseUI(); setTiles(); restyle(); });
  $('#b-off').addEventListener('click', () => { S.base = false; baseUI(); setTiles(); restyle(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.sel) { S.sel = null; writeHash(); restyle(); render(); } });
  $('#rail').addEventListener('click', (e) => {
    const t = e.target;
    const wr = t.closest('[data-ward]');
    if (wr) { e.preventDefault(); select(wr.dataset.ward, true); return; }
    if (t.closest('#closeward')) { S.sel = null; writeHash(); restyle(); render(); return; }
    const c = t.closest('[data-coal]');
    if (c) { const g = c.dataset.coal; S.coalition.has(g) ? S.coalition.delete(g) : S.coalition.add(g); render(); return; }
    const p = t.closest('[data-preset]');
    if (p) { S.coalition = new Set(PRESETS[+p.dataset.preset].p); render(); return; }
    if (t.closest('#rehearse')) { startRehearsal(); return; }
    if (t.closest('#resetpolls')) { S.override = null; recompute(); return; }
    if (t.closest('#theme')) { cycleTheme(); }
  });
  let slTimer;
  $('#rail').addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset.party) return;
    t.nextElementSibling.textContent = (+t.value).toFixed(1);
    t.style.setProperty('--v', (+t.value / 60 * 100).toFixed(1) + '%');
    if (!S.override) { S.override = {}; POLLED.forEach((g) => { S.override[g] = S.proj.T[GI[g]] * 100; }); }
    S.override[t.dataset.party] = +t.value;
    clearTimeout(slTimer);
    slTimer = setTimeout(() => recompute(true), 120);
  });
  // search
  const q = $('#q'), res = $('#qres');
  let hits = [], cur = -1;
  const show = () => {
    res.innerHTML = hits.map((h, i) => `<li role="option" id="qo-${i}" aria-selected="${i === cur}" data-w="${h.id}">${esc(h.label)}</li>`).join('');
    res.hidden = !hits.length; q.setAttribute('aria-expanded', String(!!hits.length));
  };
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase(); cur = -1;
    if (!s) { hits = []; return show(); }
    const out = [];
    const n = s.replace(/^ward\s*/, '');
    if (/^\d+$/.test(n)) W.filter((w) => String(w.no).startsWith(n)).slice(0, 8).forEach((w) => out.push({ id: w.id, label: `Ward ${w.no}` }));
    (S.st.places || []).filter((p) => p.name.toLowerCase().includes(s) && p.ward).slice(0, 10).forEach((p) => out.push({ id: p.ward, label: `${p.name} · Ward ${W[WI[p.ward]].no}` }));
    hits = out; show();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { cur = Math.min(hits.length - 1, cur + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { cur = Math.max(0, cur - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits.length) { select(hits[Math.max(0, cur)].id, true); hits = []; show(); q.blur(); }
    else if (e.key === 'Escape') { hits = []; show(); }
  });
  res.addEventListener('mousedown', (e) => { const li = e.target.closest('li'); if (li) { e.preventDefault(); select(li.dataset.w, true); hits = []; show(); q.value = ''; } });
  q.addEventListener('blur', () => setTimeout(() => { hits = []; show(); }, 150));
  // timeline
  $('#tl').addEventListener('input', (e) => { const v = +e.target.value; S.tl = v >= S.hist.length - 1 ? null : v; timelineLabel(); restyle(); render(); });
  $('#tl-play').addEventListener('click', playTimeline);
  // theme
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(themeChanged);
  new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  window.addEventListener('hashchange', () => { if (readHash()) setMode(S.mode, false); });
}
function baseUI() { $('#b-on').setAttribute('aria-pressed', String(S.base)); $('#b-off').setAttribute('aria-pressed', String(!S.base)); }
function setView(v) {
  S.view = v;
  $('#v-geo').setAttribute('aria-pressed', String(v === 'geo')); $('#v-hex').setAttribute('aria-pressed', String(v === 'hex'));
  $('#map').hidden = v !== 'geo'; $('#hex').hidden = v !== 'hex'; $('#basectrl').hidden = v !== 'geo' || (tileErrors > 6 && !tileLoads);
  $('#lvlctrl').hidden = v !== 'geo';
  if (v === 'geo') setTimeout(() => map.invalidateSize(), 0);
  restyle();
}
function themeChanged() { readColours(); if (S.view === 'geo') setTiles(); restyle(); render(); }
function cycleTheme() {
  const r = document.documentElement, cur = r.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? null : 'dark';
  if (next) r.setAttribute('data-theme', next); else r.removeAttribute('data-theme');
  try { localStorage.setItem('tv-theme', next || ''); } catch (e) { /* storage unavailable */ }
}
function themeLabel() { const t = document.documentElement.getAttribute('data-theme'); const el = $('#themelbl'); if (el) el.textContent = t || 'system'; }

// ---------------------------------------------------------------- timeline
function timelineUI() {
  const tl = $('#timeline');
  const show = S.mode === 'live' && S.hist.length > 1;
  tl.hidden = !show;
  if (!show) return;
  const r = $('#tl');
  r.max = String(S.hist.length - 1);
  r.value = String(S.tl == null ? S.hist.length - 1 : S.tl);
  timelineLabel();
}
function timelineLabel() {
  const j = S.tl == null ? S.hist.length - 1 : S.tl;
  const sn = S.hist[j]; if (!sn) return;
  $('#tl-l').textContent = S.tl == null ? 'Latest' : `Replay: ${timeSAST(sn.t, true)}`;
  $('#tl-r').textContent = `${sn.n} VDs counted`;
}
let playing = null;
function playTimeline() {
  if (playing) { clearInterval(playing); playing = null; $('#tl-play').textContent = '▶'; return; }
  S.tl = 0; $('#tl-play').textContent = '❚❚';
  playing = setInterval(() => {
    S.tl++;
    if (S.tl >= S.hist.length - 1) { S.tl = null; clearInterval(playing); playing = null; $('#tl-play').textContent = '▶'; }
    $('#tl').value = String(S.tl == null ? S.hist.length - 1 : S.tl);
    timelineLabel(); restyle(); render();
  }, Math.max(120, 6000 / S.hist.length));
}

// ---------------------------------------------------------------- rehearsal (simulated count)
function startRehearsal() {
  if (S.rehearsal) return;
  const r = rng(Date.now() % 1e9);
  const pri = S._pri || (S._pri = vdPriors());
  // a "true" outcome: one draw of the projection's uncertainty
  const f = G.map(() => Math.exp(r.normal() * 0.12));
  const wardF = W.map(() => G.map(() => Math.exp(r.normal() * 0.15)));
  const turn = Math.exp(r.normal() * 0.1);
  const truth = {};
  for (const [vd, p] of pri) {
    const q = shares(p.q.map((x, k) => x * f[k] * wardF[p.wi][k] * Math.exp(r.normal() * 0.18)));
    const n = Math.max(20, Math.round(p.ev * turn * Math.exp(r.normal() * 0.15)));
    truth[vd] = q.map((x) => Math.round(x * n));
  }
  const ids = [...pri.keys()].sort((a, b) => (sum(truth[a]) * (0.4 + r())) - (sum(truth[b]) * (0.4 + r())));
  S.realLive = S.live; S.realHist = S.hist;
  S.rehearsal = { ids, truth, i: 0, t0: Date.now() };
  S.hist = [];
  S.live = mkLive([]);
  $('#banner').hidden = false;
  $('#banner').innerHTML = 'Rehearsal · simulated count, not real results <button id="stopreh">Stop</button>';
  $('#stopreh').addEventListener('click', stopRehearsal);
  S.rehearsal.timer = setInterval(stepRehearsal, 900);
  stepRehearsal();
}
function mkLive(done) {
  const wards = {};
  const vd = {};
  W.forEach((w) => { wards[w.id] = { N: w.nvd, n: 0, v: new Array(K).fill(0), reg: 0 }; });
  const regOf = new Map(S.st.vds.map((v) => [v[0], v[3] || v[2] || 0]));
  for (const id of done) {
    const p = S._pri.get(id), a = S.rehearsal.truth[id];
    const x = wards[W[p.wi].id];
    x.n++; x.reg += regOf.get(id) || 0; x.v = x.v.map((y, k) => y + a[k]); vd[id] = a;
  }
  const city = new Array(K).fill(0); Object.values(wards).forEach((x) => x.v.forEach((y, k) => { city[k] += y; }));
  const t = new Date(Date.parse('2026-11-04T19:30:00Z') + (done.length / S.st.vds.length) * 20 * 3600e3).toISOString();
  return { status: done.length >= S.st.vds.length ? 'final' : done.length ? 'counting' : 'pre', updated: t, simulated: true, vdsTotal: S.st.vds.length, vdsCounted: done.length, city: { ward: city, pr: city }, wards, vd };
}
function stepRehearsal() {
  const R = S.rehearsal; if (!R) return;
  const step = Math.max(4, Math.round(R.ids.length / 70 * (0.6 + Math.random())));
  const before = S.live.wards;
  R.i = Math.min(R.ids.length, R.i + step);
  S.live = mkLive(R.ids.slice(0, R.i));
  S.changed = new Set(Object.keys(S.live.wards).filter((id) => S.live.wards[id].n !== (before[id] || {}).n));
  S.hist.push({ t: S.live.updated, n: S.live.vdsCounted, city: S.live.city, w: Object.fromEntries(Object.entries(S.live.wards).filter(([, x]) => x.n).map(([id, x]) => [id, [x.n, ...x.v]])) });
  S.now = nowcast(S.live);
  if (S.mode !== 'live') setMode('live'); else { timelineUI(); restyle(); render(); }
  if (R.i >= R.ids.length) { clearInterval(R.timer); R.timer = null; }
}
function stopRehearsal() {
  const R = S.rehearsal; if (!R) return;
  clearInterval(R.timer);
  S.rehearsal = null; S.live = S.realLive; S.hist = S.realHist; S.tl = null;
  S.now = nowcast(S.live);
  $('#banner').hidden = true;
  timelineUI(); restyle(); render();
}

// ---------------------------------------------------------------- data loading
async function getJSON(url, fresh) {
  const u = fresh ? url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() : url;
  const r = await fetch(u, { cache: fresh ? 'no-store' : 'default' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
async function refreshLive(first) {
  if (S.rehearsal) return;
  try {
    const L = await getJSON(FEED, true);
    const changed = !S.live || L.updated !== S.live.updated || L.vdsCounted !== S.live.vdsCounted;
    if (!first && !changed) { S.live.fetched = L.fetched; S.live.error = L.error; renderStatus(); return; }
    if (S.live && S.live.wards) {
      S.changed = new Set(Object.keys(L.wards || {}).filter((id) => (L.wards[id].n || 0) !== ((S.live.wards[id] || {}).n || 0)));
    }
    S.live = L;
    try { S.hist = await getJSON(HIST, true); } catch (e) { S.hist = S.hist || []; }
    if (S.tl != null && S.tl >= S.hist.length) S.tl = null;
    S.now = nowcast(L);
    if (!first) { timelineUI(); restyle(); render(); }
  } catch (e) {
    if (first) S.live = { status: 'pre', vdsCounted: 0, wards: {}, error: 'Live feed not reachable from this page', city: { ward: new Array(K).fill(0) } };
    if (!first) renderStatus();
  }
}

function recompute(keepSliders) {
  S.proj = project();
  S._pri = null;
  S.now = nowcast(S.live);
  restyle();
  if (keepSliders) {
    // update everything except the slider block being dragged
    const active = document.activeElement && document.activeElement.id;
    render();
    if (active) { const el = document.getElementById(active); if (el) el.focus(); }
  } else render();
}

async function boot() {
  try { const t = localStorage.getItem('tv-theme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch (e) { /* storage unavailable */ }
  try {
    [S.st, S.geo] = await Promise.all([getJSON(DATA + 'static.json'), getJSON(DATA + 'wards.geojson')]);
  } catch (e) {
    $('#rail').innerHTML = `<section class="sec"><h2>Could not load data</h2><p class="note">${esc(e.message)}. Reload the page to try again.</p></section>`;
    return;
  }
  G = S.st.groups; K = G.length; GI = Object.fromEntries(G.map((g, k) => [g, k]));
  W = S.st.wards; WI = Object.fromEntries(W.map((w, i) => [w.id, i]));
  VDI = Object.fromEntries(S.st.vds.map((v) => [v[0], v]));
  readColours();
  $('#past').innerHTML = Object.entries(S.st.elections).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#party').innerHTML = G.filter((g) => g !== 'OTH').map((g) => `<option value="${g}"${g === S.party ? ' selected' : ''}>${NAMES[g]}</option>`).join('');
  S.proj = project();
  await refreshLive(true);
  if (!readHash()) S.mode = S.live && S.live.vdsCounted ? 'live' : (Date.now() < Date.parse('2026-11-04T19:00:00Z') ? 'projection' : 'live');
  initMap(); initHex();
  bind(); baseUI();
  setMode(S.mode, true);
  if (S.sel) select(S.sel, true);
  themeLabel();
  new MutationObserver(themeLabel).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  setInterval(() => refreshLive(false), POLL_SECONDS * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshLive(false); });
}

boot();
})();
