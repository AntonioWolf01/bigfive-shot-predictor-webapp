/*
 * Team Shots Predictor.
 *
 * Data (written by predict/web.py on every run of predict.bat):
 *   data/meta.json     leagues, their weeks, the upcoming week, the spread phi
 *   data/<Div>.json    every finished match of one league, week by week
 *
 * For each team the model gives one number, the expected shots (mu). The chance of
 * every exact count comes from the same negative binomial the model is graded with:
 * mean mu, variance phi * mu.
 */
"use strict";

const state = { meta: null, league: null, week: null, match: null, cache: {} };
const $ = (sel) => document.querySelector(sel);
const SVGNS = "http://www.w3.org/2000/svg";

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const fmtDay = (iso) => { const d = parseDate(iso); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const pad2 = (n) => String(n).padStart(2, "0");

/** A match's day (YYYY-MM-DD) and kick-off time, in the visitor's own time zone. */
function when(m) {
  if (!m.kickoff) return { day: m.date, time: null };
  const d = new Date(m.kickoff);
  return {
    day: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  };
}
const fmtLong = (iso) => { const d = parseDate(iso); return `${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`; };

function fmtRange(a, b) {
  if (a === b) return fmtLong(a);
  const x = parseDate(a), y = parseDate(b);
  if (x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear())
    return `${x.getDate()}–${y.getDate()} ${MONTHS_LONG[y.getMonth()]} ${y.getFullYear()}`;
  return `${x.getDate()} ${MONTHS_LONG[x.getMonth()]} – ${fmtLong(b)}`;
}

const pct = (p) => `${(100 * p).toFixed(1)}%`;
const signed = (x) => (x >= 0.05 ? "+" : x <= -0.05 ? "−" : "±") + Math.abs(x).toFixed(1);

function initials(name) {
  const words = name.replace(/^\d+\.\s*/, "").split(/\s+/).filter((w) => /[A-Za-zÀ-ÿ]/.test(w[0]));
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

/** The team name; on phones a shorter one where the full name is long. */
function teamName(side) {
  if (!side.short || side.short === side.name) return el("span", { class: "name", text: side.name });
  return el("span", { class: "name", title: side.name },
    el("span", { class: "full", text: side.name }), el("span", { class: "short", text: side.short }));
}

function logo(side, cls = "logo") {
  if (side.logo) return el("img", { class: cls, src: side.logo, alt: "", loading: "lazy", decoding: "async" });
  return el("span", { class: "initials", "aria-hidden": "true", text: initials(side.name) });
}

// ------------------------------------------------------------ distribution

/** P(exactly k shots) for k = 0..kmax: negative binomial, mean mu, variance phi*mu. */
function nbPmf(mu, phi, kmax) {
  mu = Math.max(mu, 1e-3);
  const p = 1 / phi, n = (mu * p) / (1 - p);
  const out = new Array(kmax + 1);
  let v = Math.exp(n * Math.log(p));
  out[0] = v;
  for (let k = 0; k < kmax; k++) {
    v = (v * (k + n) * (1 - p)) / (k + 1);
    out[k + 1] = v;
  }
  return out;
}

/** P(shots <= line) for a half line (12.5 -> P(shots <= 12)). */
function cdfAt(pmf, line) {
  let s = 0;
  for (let k = 0; k <= Math.floor(line) && k < pmf.length; k++) s += pmf[k];
  return Math.min(1, s);
}

// --------------------------------------------------------------------- data

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function loadLeague(div) {
  if (!state.cache[div]) state.cache[div] = getJSON(`data/${div}.json?v=${state.meta.updated}`);
  return state.cache[div];
}

// ------------------------------------------------------------------ routing

function readHash() {
  const [div, week, match] = location.hash.replace(/^#\/?/, "").split("/");
  return { div, week: Number(week) || null, match: Number(match) || null };
}

function writeHash() {
  const h = `#/${state.league.div}/${state.week}` + (state.match ? `/${state.match}` : "");
  if (location.hash !== h) history.replaceState(null, "", h);
}

// ---------------------------------------------------------------- top bars

function renderLeagues() {
  const nav = $("#leagues");
  nav.replaceChildren(...state.meta.leagues.map((lg) =>
    el("button", {
      class: "league", type: "button", "aria-pressed": String(lg === state.league),
      onclick: () => selectLeague(lg.div),
    },
    el("span", { class: "badge" }, lg.logo ? el("img", { src: lg.logo, alt: "" }) : null),
    lg.name)));
}

function renderWeeks() {
  const lg = state.league;
  const chips = lg.weeks.map((w) => {
    const ahead = !lg.played_weeks.includes(w);
    return el("button", {
      class: `week${ahead ? " ahead" : ""}`, type: "button", "aria-pressed": String(w === state.week),
      title: ahead ? "Upcoming matches: predictions only" : null, onclick: () => selectWeek(w),
    }, `Week ${w}`);
  });
  if (lg.upcoming) {
    chips.push(el("button", {
      class: "week upcoming", type: "button", "aria-pressed": String(lg.upcoming === state.week),
      title: "Predictions not published yet", onclick: () => selectWeek(lg.upcoming),
    }, `Week ${lg.upcoming}`));
  }
  const nav = $("#weeks");
  nav.replaceChildren(...chips);
  const on = nav.querySelector('[aria-pressed="true"]');
  if (on) on.scrollIntoView({ block: "nearest", inline: "center" });
}

function selectLeague(div) {
  const lg = state.meta.leagues.find((l) => l.div === div) || state.meta.leagues[0];
  if (state.league && state.league !== lg) state.match = null;
  state.league = lg;
  const want = state.week;
  const latest = lg.played_weeks[lg.played_weeks.length - 1] ?? lg.weeks[lg.weeks.length - 1] ?? lg.upcoming;
  state.week = lg.weeks.includes(want) || want === lg.upcoming ? want : latest;
  renderLeagues();
  renderWeeks();
  renderContent();
}

function selectWeek(w) {
  state.week = w;
  state.match = null;
  renderWeeks();
  renderContent();
}

// ------------------------------------------------------------------ content

async function renderContent() {
  writeHash();
  const main = $("#content");
  const lg = state.league, week = state.week;

  if (week === lg.upcoming || !lg.weeks.includes(week)) {
    main.replaceChildren(el("div", { class: "empty" },
      el("h2", { text: "Match predictions are not available yet." }),
      el("p", { text: `Week ${week} will appear here as soon as the forecasts are published.` })));
    return;
  }

  let doc;
  try {
    doc = await loadLeague(lg.div);
  } catch (e) {
    main.replaceChildren(el("p", { class: "status", text: "The data could not be loaded. Please refresh the page." }));
    return;
  }
  if (state.league !== lg || state.week !== week) return;      // the user moved on

  const block = doc.weeks.find((w) => w.week === week);
  // in kick-off order; matches at the same time by home team
  const matches = [...block.matches].sort((a, b) =>
    (a.kickoff || a.date).localeCompare(b.kickoff || b.date)
    || a.home.name.localeCompare(b.home.name, "en", { sensitivity: "base" }));
  const dates = matches.map((m) => when(m).day).sort();

  main.replaceChildren(
    el("div", { class: "week-head" },
      el("h2", { text: `Week ${week}` }),
      el("span", { text: `${fmtRange(dates[0], dates[dates.length - 1])} · ${matches.length} matches` })),
    el("div", { class: "matches" }, matches.map(matchCard)));

  // a link to one match (#/E0/5/<id>) opens it
  const target = state.match && main.querySelector(`#m${state.match}`);
  if (target) {
    const card = target.closest(".match");
    toggle(card, card.querySelector(".match-row"), matches.find((m) => m.id === state.match));
    requestAnimationFrame(() => scrollTo({ top: card.getBoundingClientRect().top + scrollY - 16 }));
  } else state.match = null;
}

function matchCard(m) {
  const hw = m.played && m.home.goals > m.away.goals, aw = m.played && m.away.goals > m.home.goals;
  const bodyId = `m${m.id}`, t = when(m);
  const card = el("article", { class: `match${m.played ? "" : " ahead"}` });
  const score = m.played
    ? el("div", { class: "score", "aria-label": `${m.home.goals} to ${m.away.goals}` },
      String(m.home.goals), el("i", { text: "–" }), String(m.away.goals))
    : el("div", { class: "score vs", text: "vs" });
  const row = el("button", {
    class: "match-row", type: "button", "aria-expanded": "false", "aria-controls": bodyId,
    onclick: () => toggle(card, row, m),
  },
  el("div", { class: "date" }, el("b", { text: fmtDay(t.day) }), t.time),
  el("div", { class: `team home${hw ? " winner" : ""}` }, teamName(m.home), logo(m.home)),
  score,
  el("div", { class: `team away${aw ? " winner" : ""}` }, logo(m.away), teamName(m.away)),
  el("span", { class: "chev", "aria-hidden": "true" },
    chevron()));
  card.append(row, el("div", { class: "match-body", id: bodyId }, el("div", { class: "inner" })));
  return card;
}

function chevron() {
  const s = svg("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none" });
  s.append(svg("path", { d: "M3 5.2 7 9l4-3.8", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
  return s;
}

function toggle(card, row, m) {
  const inner = card.querySelector(".inner");
  if (!inner.childElementCount) {
    inner.append(el("div", { class: "panels" },
      teamPanel(m.home, "home", m.played, m.odds), teamPanel(m.away, "away", m.played, m.odds)));
    if (m.note) inner.append(el("p", { class: "note", text: m.note }));
    const nBets = (m.home.bets || []).length + (m.away.bets || []).length;
    if (m.odds && nBets) inner.append(el("p", { class: "bets-note", text: BETS_NOTE }));
    else if (m.odds) inner.append(el("p", { class: "note", text: "No value bets available for this match." }));
    else if (!m.played) inner.append(el("p", { class: "note", text: "Odds not published yet." }));
  }
  const open = !card.classList.contains("open");
  card.classList.toggle("open", open);
  row.setAttribute("aria-expanded", String(open));
  state.match = open ? m.id : (state.match === m.id ? null : state.match);
  writeHash();
  if (open) requestAnimationFrame(() => inner.querySelectorAll(".chart").forEach((c) => c.draw && c.draw()));
}

// --------------------------------------------------------------- team panel

function teamPanel(side, venue, played, hasOdds) {
  const top = el("div", { class: "panel-top" },
    logo(side),
    el("div", { class: "team-name", text: side.name }),
    el("div", { class: "side", text: venue === "home" ? "Home" : "Away" }));
  // the value bets of this team; null: no odds known, so no section at all
  const bets = hasOdds ? side.bets || [] : null;

  if (!played) {
    const phi = state.meta.phi, mu = side.expected;
    return el("section", { class: `panel ${venue}` }, top,
      el("div", { class: "actual" },
        el("div", { class: "label", text: "Expected shots" }),
        el("div", { class: "actual-value", text: mu.toFixed(1) })),
      distribution(nbPmf(mu, phi, 80), mu, null, phi, bets));
  }

  const panel = el("section", { class: `panel ${venue}` }, top,
    el("div", { class: "actual" },
      el("div", { class: "label", text: "Actual shots" }),
      el("div", { class: "actual-value", text: String(side.shots) })));

  if (side.expected == null) return panel;

  const phi = state.meta.phi, mu = side.expected, y = side.shots;
  const pmf = nbPmf(mu, phi, Math.max(80, y + 20));
  const actual = panel.querySelector(".actual");
  actual.append(el("div", { class: "delta" },
    el("b", { text: signed(y - mu) }), ` vs ${mu.toFixed(1)} expected`));

  // the chance, before kick-off, of the result that happened
  const over = y > 0 ? 1 - cdfAt(pmf, y - 0.5) : null;
  const under = cdfAt(pmf, y + 0.5);
  const odds = el("div", { class: `odds${over == null ? " single" : ""}` },
    over == null ? null : el("div", {}, el("span", { text: `Over ${(y - 0.5).toFixed(1)}` }), el("b", { text: pct(over) })),
    el("div", {}, el("span", { text: `Under ${(y + 0.5).toFixed(1)}` }), el("b", { text: pct(under) })));
  actual.append(odds, el("p", { class: "odds-caption", text: "Chance of this result, before kick-off" }));

  panel.append(distribution(pmf, mu, y, phi, bets));
  return panel;
}

// --------------------------------------------------------------- value bets

const BETS_NOTE = "A line is a value bet when model probability × odds is at least 1.03. "
  + "Stake: full Kelly, (probability × odds − 1) / (odds − 1), as a share of the budget.";

const signedPct = (x) => `${x >= 0 ? "+" : "−"}${(100 * Math.abs(x)).toFixed(1)}%`;
const betName = (b) => `${b.side === "over" ? "Over" : "Under"} ${b.line.toFixed(1)}`;

/** The team's value bets; a row moves the chart's line to that bet. */
function betList(bets, goTo) {
  if (!bets.length) return el("p", { class: "bets-none", text: "No value bets for this team." });
  return el("div", { class: "bets" },
    el("div", { class: "label", text: "Value bets" }),
    el("div", { class: "bet head", "aria-hidden": "true" },
      el("span", { text: "Line" }), el("span", { text: "Odds" }),
      el("span", { text: "Edge" }), el("span", { text: "Stake" })),
    bets.map((b) => el("button", {
      class: "bet", type: "button", onclick: () => goTo(b.line),
      title: `Model ${pct(b.p)} · show on the chart`,
      "aria-label": `${betName(b)} at ${b.odds.toFixed(2)}: model ${pct(b.p)}, edge ${signedPct(b.edge)}, `
        + `stake ${pct(b.kelly)} of the budget. Show on the chart.`,
    },
    el("span", { text: betName(b) }), el("span", { text: b.odds.toFixed(2) }),
    el("span", { text: signedPct(b.edge) }), el("b", { text: pct(b.kelly) }))));
}

// -------------------------------------------------------------------- chart

function distribution(pmf, mu, y, phi, bets = null) {
  const sd = Math.sqrt(phi * mu);
  const half = Math.max(8, Math.ceil(3 * sd));
  const c = Math.round(mu);
  const lines = (bets || []).map((b) => b.line);
  const kmin = Math.max(0, Math.min(y == null ? c - half : Math.min(c - half, y), ...lines.map(Math.floor)));
  const kmax = Math.min(pmf.length - 1, Math.max(y == null ? c + half : Math.max(c + half, y), ...lines.map(Math.ceil)));
  let line = Math.min(Math.max(Math.floor(mu) + 0.5, kmin + 0.5), kmax - 0.5);

  const readLine = el("b");
  const readOver = el("b"), readUnder = el("b");
  const readout = el("div", { class: "readout" },
    el("div", { class: "line-now" }, "Line", readLine),
    el("div", { class: "pair" },
      el("div", {}, el("span", { class: "key over" }), "Over", readOver),
      el("div", {}, el("span", { class: "key under" }), "Under", readUnder)));

  const chart = el("div", { class: "chart" });
  const slider = el("input", {
    type: "range", min: kmin + 0.5, max: kmax - 0.5, step: 1, value: line,
    "aria-label": "Shots line",
  });
  const sliderWrap = el("div", { class: "slider" }, slider);
  const legend = el("div", { class: "chart-legend" },
    y == null ? null : el("span", {}, el("span", { class: "key act" }), "Actual shots"),
    el("span", {}, el("span", { class: "key exp" }), "Expected shots"));

  const goTo = (v) => { slider.value = v; setLine(v); };
  const block = el("div", { class: "chart-block" }, readout, chart, sliderWrap, legend,
    bets ? betList(bets, goTo) : null);

  let bars = [], cut = null, x = null, shown = { over: null, under: null };

  function setLine(v, animate = true) {
    line = v;
    readLine.textContent = line.toFixed(1);
    const pu = cdfAt(pmf, line), po = 1 - pu;
    tween(readOver, shown.over, po, animate); shown.over = po;
    tween(readUnder, shown.under, pu, animate); shown.under = pu;
    bars.forEach((b) => b.el.classList.toggle("over", b.k > line));
    if (cut && x) cut.style.transform = `translateX(${x(line)}px)`;
    slider.setAttribute("aria-valuetext", `Over ${line.toFixed(1)}: ${pct(po)}, under: ${pct(pu)}`);
  }

  function draw() {
    const W = chart.clientWidth;
    if (!W) return;
    const m = { t: 30, r: 6, b: lines.length ? 31 : 22, l: 30 }, H = 148 + m.b;
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const n = kmax - kmin + 1, band = pw / n;
    x = (k) => m.l + (k - kmin + 0.5) * band;
    const top = Math.max(...pmf.slice(kmin, kmax + 1));
    const step = niceStep(top);
    const ymax = Math.max(top * 1.08, step);
    const yv = (p) => m.t + ph - (p / ymax) * ph;

    const s = svg("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": `Chance of each number of shots. Expected ${mu.toFixed(1)}` + (y == null ? "." : `, actual ${y}.`) });

    for (let v = step; v <= ymax + 1e-9; v += step) {
      s.append(svg("line", { class: "grid-line", x1: m.l, x2: W - m.r, y1: yv(v), y2: yv(v) }));
      const t = svg("text", { class: "tick", x: m.l - 6, y: yv(v) + 3, "text-anchor": "end" });
      t.textContent = `${Math.round(v * 100)}%`;
      s.append(t);
    }
    s.append(svg("line", { class: "exp-line", x1: x(mu), x2: x(mu), y1: m.t - 6, y2: m.t + ph }));

    const bw = Math.min(24, Math.max(2, band - 2)), r = Math.min(4, bw / 3);
    bars = [];
    for (let k = kmin; k <= kmax; k++) {
      const bx = x(k) - bw / 2, by = yv(pmf[k]), bh = m.t + ph - by;
      const bar = svg("path", { class: `bar${k === y ? " actual" : ""}`, d: roundTop(bx, by, bw, bh, r) });
      const hit = svg("rect", { class: "hit", x: x(k) - band / 2, y: m.t, width: band, height: ph });
      const info = { k, p: pmf[k] };
      hit.addEventListener("pointerenter", (e) => { bar.classList.add("hover"); showTip(e, info, k === y); });
      hit.addEventListener("pointermove", (e) => showTip(e, info, k === y));
      hit.addEventListener("pointerleave", () => { bar.classList.remove("hover"); hideTip(); });
      hit.addEventListener("click", () => { const v = Math.min(Math.max(k - 0.5, kmin + 0.5), kmax - 0.5); slider.value = v; setLine(v); });
      s.append(bar, hit);
      bars.push({ k, el: bar });
    }
    s.append(svg("line", { class: "base-line", x1: m.l, x2: W - m.r, y1: m.t + ph, y2: m.t + ph }));

    // a diamond under the axis at every value-bet line
    for (const v of new Set(lines)) {
      const cx = x(v), cy = m.t + ph + 7;
      const d = svg("path", { class: "bet-mark", d: `M${cx},${cy - 4.5}l4,4.5l-4,4.5l-4,-4.5z` });
      d.addEventListener("click", () => goTo(v));
      s.append(d);
    }

    const every = n > 30 ? 10 : 5;
    for (let k = Math.ceil(kmin / every) * every; k <= kmax; k += every) {
      const t = svg("text", { class: "tick", x: x(k), y: H - 6, "text-anchor": "middle" });
      t.textContent = k;
      s.append(t);
    }

    // expected-shots marker and label, kept inside the plot
    const ex = x(mu);
    s.append(svg("path", { class: "exp-mark", d: `M${ex - 4.5},${m.t - 11} h9 l-4.5,6 z` }));
    const lab = svg("text", { class: "exp-label", y: m.t - 16, "text-anchor": "middle" });
    lab.textContent = `Expected ${mu.toFixed(1)}`;
    s.append(lab);

    cut = svg("g", { class: "cut" });
    cut.append(svg("line", { x1: 0, x2: 0, y1: m.t - 2, y2: m.t + ph }));
    s.append(cut);

    chart.replaceChildren(s);
    const lw = lab.getComputedTextLength ? lab.getComputedTextLength() : 80;
    lab.setAttribute("x", Math.min(Math.max(ex, m.l + lw / 2), W - m.r - lw / 2));

    // the slider's thumb centre travels from x(kmin+0.5) to x(kmax-0.5)
    const thumb = 18, a = x(kmin + 0.5), b = x(kmax - 0.5);
    slider.style.left = `${a - thumb / 2}px`;
    slider.style.width = `${b - a + thumb}px`;

    cut.style.transition = "none";
    setLine(line, false);
    cut.getBoundingClientRect();
    cut.style.transition = "";
  }

  slider.addEventListener("input", () => setLine(Number(slider.value)));
  chart.draw = draw;
  new ResizeObserver(() => draw()).observe(chart);
  return block;
}

function roundTop(x, y, w, h, r) {
  if (h <= 0.5) return `M${x},${y + h}h${w}`;
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function niceStep(top) {
  const raw = top / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

function tween(node, from, to, animate) {
  if (!animate || from == null || matchMedia("(prefers-reduced-motion: reduce)").matches) {
    node.textContent = pct(to);
    return;
  }
  cancelAnimationFrame(node._raf);
  const t0 = performance.now(), dur = 260;
  const stepFn = (t) => {
    const u = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - u, 3);
    node.textContent = pct(from + (to - from) * e);
    if (u < 1) node._raf = requestAnimationFrame(stepFn);
  };
  node._raf = requestAnimationFrame(stepFn);
}

// ------------------------------------------------------------------ tooltip

const tip = $("#tip");
function showTip(e, info, isActual) {
  tip.replaceChildren(
    el("b", { text: pct(info.p) }),
    el("span", { text: `exactly ${info.k} shot${info.k === 1 ? "" : "s"}${isActual ? " · actual" : ""}` }));
  tip.hidden = false;
  const pad = 70;
  tip.style.left = `${Math.min(Math.max(e.clientX, pad), innerWidth - pad)}px`;
  tip.style.top = `${e.clientY}px`;
}
function hideTip() { tip.hidden = true; }
addEventListener("scroll", hideTip, { passive: true });

// --------------------------------------------------------------------- boot

async function boot() {
  try {
    state.meta = await getJSON(`data/meta.json?t=${Date.now()}`);
  } catch (e) {
    $("#content").replaceChildren(el("p", { class: "status", text: "The data could not be loaded. Please refresh the page." }));
    return;
  }
  const meta = state.meta;
  $("#season").textContent = meta.season;
  $("#updated").textContent = (meta.last_match ? `Results up to ${fmtLong(meta.last_match)} · ` : "")
    + `updated ${fmtLong(meta.updated)}`;
  const { div, week, match } = readHash();
  state.week = week;
  state.match = match;
  selectLeague(div);
}

addEventListener("hashchange", () => {
  const { div, week, match } = readHash();
  if (!state.meta || (div === state.league?.div && week === state.week)) return;
  state.week = week;
  state.match = match;
  selectLeague(div);
});

boot();
