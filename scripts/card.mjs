// Builds the profile card as one SVG per theme: an animated ASCII Lissajous background, a curved
// marquee, a 3D contribution graph with a translucent daily-spend surface, and contact emails.
// Usage: node scripts/card.mjs <calendar.json> <outDir> [usageDir]
//   calendar.json: gh api graphql -f query='query($u:String!){user(login:$u){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionCount date}}}}}}' -f u=<login>
//   usageDir: optional folder of <device>.json files, { updated, days: { "YYYY-MM-DD": { tokens, cost } } }
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const [calFile, outDir = "assets", usageDir = ""] = process.argv.slice(2);
const YEAR = new Date().getUTCFullYear();
const EMAILS = ["rs2489@cornell.edu", "rshi@gatech.edu", "r@rshi.pro"];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const md = (s) => `${+s.slice(5, 7)}/${+s.slice(8, 10)}`;
const addDay = (s, n) => new Date(Date.parse(s + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// ── usage: merge devices by date; remember each device's tracked span ──
const usage = {};
const spans = [];
if (usageDir && existsSync(usageDir)) {
  for (const f of readdirSync(usageDir).filter((n) => /^[a-z]\.json$/.test(n))) {
    const file = JSON.parse(readFileSync(join(usageDir, f), "utf8"));
    const dates = Object.keys(file.days || {}).filter(isDate).sort();
    if (!dates.length) continue;
    spans.push({ first: dates[0], last: [dates.at(-1), isDate(file.updated) ? file.updated : ""].sort().at(-1) });
    for (const date of dates) {
      const v = file.days[date], tokens = Number(v?.tokens), cost = Number(v?.cost);
      if (!Number.isFinite(tokens) || tokens < 0) continue;
      usage[date] = usage[date] || { tokens: 0, cost: 0 };
      usage[date].tokens += tokens;
      usage[date].cost += Number.isFinite(cost) && cost >= 0 ? cost : 0;
    }
  }
}

// ── layout ──────────────────────────────────────────────────────────────
const W = 1344;
const BANNER = { y: 0, h: Math.round((W * 100) / 860) };

// ── contribution graph ──────────────────────────────────────────────────
const cal = JSON.parse(readFileSync(calFile, "utf8")).data.user.contributionsCollection.contributionCalendar.weeks;
const days = [];
cal.forEach((wk, w) => wk.contributionDays.forEach((d) => days.push({ w, d: new Date(d.date + "T00:00:00Z").getUTCDay(), date: d.date, n: d.contributionCount, tk: usage[d.date]?.tokens || 0, usd: usage[d.date]?.cost || 0 })));
const WEEKS = cal.length;
const max = Math.max(1, ...days.map((x) => x.n));
const total = days.reduce((s, x) => s + x.n, 0);
const totalTk = days.reduce((s, x) => s + x.tk, 0);
const totalUsd = days.reduce((s, x) => s + x.usd, 0);

// Usage window inside the graph: earliest tracked day to latest synced day.
const gStart = days[0].date, gEnd = days.at(-1).date;
const winStart = spans.length ? [gStart, spans.map((s) => s.first).sort()[0]].sort().at(-1) : "";
const winEnd = spans.length ? [gEnd, spans.map((s) => s.last).sort().at(-1)].sort()[0] : "";
const usagePeriod = winStart ? `(${md(winStart)}-${md(winEnd)})` : "";
// Partial days: inside the window, but at least one device was not tracking yet (or had not synced).
const partial = [];
if (spans.length > 1) for (let d = winStart; d <= winEnd; d = addDay(d, 1)) if (spans.some((s) => d < s.first || d > s.last)) partial.push(d);
const runs = [];
for (const d of partial) { const r = runs.at(-1); if (r && addDay(r.to, 1) === d) r.to = d; else runs.push({ from: d, to: d }); }

const S = 15, U = [S * 0.94, S * 0.34], V = [-S * 0.52, S * 0.58], HZ = S * 0.95, BAR = 0.78;
const proj = (x, y, z) => [x * U[0] + y * V[0], x * U[1] + y * V[1] - z * HZ];
const height = (n) => (n === 0 ? 0.12 : 0.35 + 4.2 * Math.sqrt(n / max));
const level = (n) => (n === 0 ? 0 : n <= max * 0.15 ? 1 : n <= max * 0.35 ? 2 : n <= max * 0.6 ? 3 : 4);
let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
const grow = (...pts) => { for (const [x, y] of pts) { mnX = Math.min(mnX, x); mxX = Math.max(mxX, x); mnY = Math.min(mnY, y); mxY = Math.max(mxY, y); } };
const bars = days.map(({ w, d, n }) => {
  const h = height(n), x1 = w + BAR, y1 = d + BAR;
  const p = { t00: proj(w, d, h), t10: proj(x1, d, h), t11: proj(x1, y1, h), t01: proj(w, y1, h), b10: proj(x1, d, 0), b11: proj(x1, y1, 0), b01: proj(w, y1, 0) };
  grow(...Object.values(p));
  return { w, p, lv: level(n), depth: proj(w + BAR / 2, d + BAR / 2, 0)[1] };
}).sort((a, b) => a.depth - b.depth);

// ── spend surface: Gaussian-smoothed daily spend over the week × weekday floor ──
const ZMAX = 7.5, SIGMA = 0.9, STEP = 0.5;
const costGrid = Array.from({ length: WEEKS }, () => Array(7).fill(0));
for (const x of days) costGrid[x.w][x.d] = x.usd;
const smooth = Array.from({ length: WEEKS }, () => Array(7).fill(0));
for (let w = 0; w < WEEKS; w++) for (let d = 0; d < 7; d++) {
  let s = 0, k = 0;
  for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
    const ww = w + i, dd = d + j, g = Math.exp(-(i * i + j * j) / (2 * SIGMA * SIGMA));
    k += g;
    if (ww >= 0 && ww < WEEKS && dd >= 0 && dd < 7) s += costGrid[ww][dd] * g;
  }
  smooth[w][d] = s / k;
}
const sMax = Math.max(1e-9, ...smooth.flat());
const zTop = Math.max(500, Math.ceil(sMax / 500) * 500); // cost axis in $500 steps
const zTicks = Array.from({ length: zTop / 500 }, (_, i) => (i + 1) * 500);
const field = (x, y) => { // bilinear over cell centres
  const fx = Math.min(Math.max(x - BAR / 2, 0), WEEKS - 1), fy = Math.min(Math.max(y - BAR / 2, 0), 6);
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, WEEKS - 1), y1 = Math.min(y0 + 1, 6), tx = fx - x0, ty = fy - y0;
  const v = smooth[x0][y0] * (1 - tx) * (1 - ty) + smooth[x1][y0] * tx * (1 - ty) + smooth[x0][y1] * (1 - tx) * ty + smooth[x1][y1] * tx * ty;
  return (v / zTop) * ZMAX;
};
const quads = [];
if (totalUsd > 0) {
  for (let x = 0; x < WEEKS; x += STEP) for (let y = 0; y < 7 - 1e-9; y += STEP) {
    const c = [[x, y], [x + STEP, y], [x + STEP, y + STEP], [x, y + STEP]].map(([a, b]) => [a, b, field(a, b)]);
    const zAvg = c.reduce((s, q) => s + q[2], 0) / 4;
    if (Math.max(...c.map((q) => q[2])) < ZMAX * 0.01) continue;
    const pts = c.map(([a, b, z]) => proj(a, b, z));
    grow(...pts);
    quads.push({ pts, zAvg, depth: proj(x + STEP / 2, y + STEP / 2, 0)[1] });
  }
  quads.sort((a, b) => a.depth - b.depth);
}

// ── axes: weeks along the front edge, weekdays on the left, spend vertical ──
const AX = { y: 7.35, x: -0.45 };
const axisPts = { o: proj(AX.x, AX.y, 0), xEnd: proj(WEEKS, AX.y, 0), yEnd: proj(AX.x, 0, 0), zEnd: proj(AX.x, AX.y, ZMAX + 0.6) };
grow(...Object.values(axisPts), proj(AX.x, AX.y + 3.8, 0), proj(AX.x - 2.2, AX.y, ZMAX), proj(WEEKS, AX.y + 3.8, 0));
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthTicks = [];
cal.forEach((wk, w) => {
  const first = wk.contributionDays.find((d) => d.date.endsWith("-01"));
  if (first && w > 0) monthTicks.push({ w, label: MONTHS[+first.date.slice(5, 7) - 1] });
});
const weekOf = Object.fromEntries(days.map((x) => [x.date, x.w]));

const SKW = mxX - mnX, SKH = mxY - mnY;
const SKY = { x: 48, w: W - 96 };
SKY.h = Math.round((SKY.w * SKH) / SKW);
SKY.y = BANNER.h + 8;
const pt = (q) => `${(q[0] - mnX).toFixed(1)},${(q[1] - mnY).toFixed(1)}`;
const L = (a, b) => `M${pt(a)}L${pt(b)}`;
const at = (q, cls, anchor, label, dy = 0) => `<text x="${(q[0] - mnX).toFixed(1)}" y="${(q[1] - mnY + dy).toFixed(1)}" text-anchor="${anchor}" class="${cls}">${label}</text>`;
const skylineBars = bars.map(({ p, lv, w }) =>
  `<g class="sb sl${lv}" style="animation-delay:${w * 18}ms"><polygon class="sf" points="${pt(p.t01)} ${pt(p.t11)} ${pt(p.b11)} ${pt(p.b01)}"/><polygon class="sr" points="${pt(p.t10)} ${pt(p.t11)} ${pt(p.b11)} ${pt(p.b10)}"/><polygon class="st" points="${pt(p.t00)} ${pt(p.t10)} ${pt(p.t11)} ${pt(p.t01)}"/></g>`).join("");
// Quads are opaque within the group and stroked in their own fill, so no mesh lines show;
// the group's opacity makes the surface translucent. Shade steps with height.
const surface = quads.map(({ pts, zAvg }) =>
  `<polygon class="z${Math.min(5, Math.floor((zAvg / ZMAX) * 6))}" points="${pts.map(pt).join(" ")}"/>`).join("");
const zf = (v) => (v / zTop) * ZMAX;
const ax = axisPts;
const axisLines = `<path class="ax" d="${L(ax.o, ax.xEnd)}${L(ax.o, ax.yEnd)}${L(ax.o, ax.zEnd)}${monthTicks.map(({ w }) => L(proj(w, AX.y, 0), proj(w, AX.y + 0.35, 0))).join("")}${totalUsd ? zTicks.map((v) => L(proj(AX.x, AX.y, zf(v)), proj(AX.x - 0.35, AX.y + 0.15, zf(v)))).join("") : ""}"/>`;
const money = (v) => "$" + v.toLocaleString("en-US");
// Partial-data brackets under the axis: dashed span plus a small label.
const PB = AX.y + 2.0;
const partialMarks = runs.filter((r) => weekOf[r.from] !== undefined && weekOf[r.to] !== undefined).map((r) => {
  const a = proj(weekOf[r.from], PB, 0), b = proj(weekOf[r.to] + BAR, PB, 0);
  const mid = proj((weekOf[r.from] + weekOf[r.to] + BAR) / 2, PB + 1.55, 0);
  return `<path class="pb" d="${L(a, b)}${L(a, proj(weekOf[r.from], PB - 0.3, 0))}${L(b, proj(weekOf[r.to] + BAR, PB - 0.3, 0))}"/>${at(mid, "axl", "middle", `partial ${md(r.from)}${r.to !== r.from ? "-" + md(r.to) : ""}`)}`;
}).join("");
const axisLabels = [
  ...monthTicks.map(({ w, label }) => at(proj(w, AX.y + 1.25, 0), "axl", "middle", label)),
  ...(totalUsd ? zTicks : []).map((v) => at(proj(AX.x - 0.6, AX.y + 0.2, zf(v)), "axl", "end", `${money(v)}${v === zTop ? "/day" : ""}`, 3)),
].join("");
const skylineBody = `${skylineBars}<g class="srf">${surface}</g><g class="axes">${axisLines}${axisLabels}${partialMarks}</g>`;

const FOOT = { statY: SKY.y + SKY.h + 52 };
FOOT.mailY = FOOT.statY + 48;
const H = FOOT.mailY + 34;
function compact(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + "b" : n >= 1e6 ? (n / 1e6).toFixed(1) + "m" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)); }

// ── curved marquee ──────────────────────────────────────────────────────
const BP = [
  { x: -100, y: -20 }, { cx: 30, cy: -20, x: 95, y: -20 }, { cx: 160, cy: -23, x: 265, y: -23 }, { cx: 370, cy: -13, x: 455, y: -11 },
  { cx: 540, cy: -10, x: 620, y: -14 }, { cx: 660, cy: -16, x: 700, y: -20 }, { cx: 800, cy: -29, x: 850, y: -32 }, { cx: 875, cy: -33, x: 900, y: -34 },
  { cx: 925, cy: -35, x: 950, y: -34 }, { cx: 1040, cy: -31, x: 1090, y: -28 }, { type: "C", cx1: 1130, cy1: -25.6, cx2: 1190, cy2: 0, x: 1230, y: 0 },
  { cx: 1335, cy: 0, x: 1385, y: 0 }, { cx: 1460, cy: 0, x: 1540, y: 0 },
];
const by = (v) => +(v + 78).toFixed(1);
let bd = `M${BP[0].x},${by(BP[0].y)}`;
for (const p of BP.slice(1)) bd += p.type === "C" ? ` C${p.cx1},${by(p.cy1)} ${p.cx2},${by(p.cy2)} ${p.x},${by(p.y)}` : ` Q${p.cx},${by(p.cy)} ${p.x},${by(p.y)}`;
const UNIT = 430, REPS = 5;
const bannerText = `✦ REI-Q ✦ ${YEAR} `.repeat(REPS).replace(/ /g, "&#160;");

// ── Lissajous background ────────────────────────────────────────────────
// Four blobs follow Lissajous curves at a speed far above the frame rate, so each frame lands at a
// near-random point on its curve. One ASCII blob sprite, four <use> copies, discrete positions.
const CELL = 14, COLS = Math.ceil(W / CELL), ROWS = Math.ceil(H / CELL);
const CHARS = " .·-:=+*#@█", FALLOFF = 0.15, FRAME_MS = 1000 / 30, LOOP_S = 30;
const CURVES = [{ a: 3, b: 4, ph: 0 }, { a: 5, b: 4, ph: Math.PI / 4 }, { a: 3, b: 2, ph: Math.PI / 2 }, { a: 7, b: 6, ph: Math.PI / 3 }];
const SPEED = 0.35;
const R = Math.ceil(Math.log(1 / 0.15) / FALLOFF) + 1;
const spriteRows = [[], [], []];
for (let dy = -R; dy <= R; dy++) {
  const rows = [Array(2 * R + 1).fill(" "), Array(2 * R + 1).fill(" "), Array(2 * R + 1).fill(" ")];
  for (let dx = -R; dx <= R; dx++) {
    const v = Math.min(Math.exp(-Math.hypot(dx, dy) * FALLOFF) / 1.3, 1);
    const ch = CHARS[Math.min(Math.floor(v * (CHARS.length - 1)), CHARS.length - 1)];
    if (ch !== " ") rows[v > 0.7 ? 2 : v > 0.4 ? 1 : 0][dx + R] = ch;
  }
  rows.forEach((r, li) => {
    const s = r.join(""), a = s.search(/\S/);
    if (a < 0) return;
    const seg = s.slice(a, s.trimEnd().length);
    spriteRows[li].push(`<text x="${(a - R) * CELL}" y="${(dy + 1) * CELL - 3}" textLength="${seg.length * CELL}" lengthAdjust="spacing">${seg.replace(/ /g, "&#160;")}</text>`);
  });
}
const NF = Math.round((LOOP_S * 1000) / FRAME_MS);
const blobs = CURVES.map((c) => {
  const xs = [], ys = [];
  for (let i = 0; i < NF; i++) {
    const t = 5000 + i * FRAME_MS;
    xs.push(Math.round(COLS / 2 + Math.sin(c.a * t * SPEED + c.ph) * COLS * 0.4) * CELL);
    ys.push(Math.round(ROWS / 2 + Math.sin(c.b * t * SPEED + c.ph * 1.5) * ROWS * 0.4) * CELL);
  }
  return `<use href="#blob" x="${xs[0]}" y="${ys[0]}"><animate attributeName="x" values="${xs.join(";")}" dur="${LOOP_S}s" calcMode="discrete" repeatCount="indefinite"/><animate attributeName="y" values="${ys.join(";")}" dur="${LOOP_S}s" calcMode="discrete" repeatCount="indefinite"/></use>`;
}).join("\n");

// ── assemble ────────────────────────────────────────────────────────────
const FONT_UI = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
function card(t) {
  const shade = (hex, k) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0")).join("");
  const skCss = t.sky.map((c, i) => `.sl${i} .st{fill:${c}}.sl${i} .sr{fill:${shade(c, 0.72)}}.sl${i} .sf{fill:${shade(c, 0.55)}}`).join("");
  const mails = EMAILS.map((e, i) => `<text x="${Math.round((W * (2 * i + 1)) / 6)}" y="${FOOT.mailY}" text-anchor="middle" class="mail">${e}</text>`).join("");
  const statRow = totalTk
    ? `<text x="${W / 2}" y="${FOOT.statY}" text-anchor="middle" class="stat">${compact(totalTk).toUpperCase()} tokens = ${compact(totalUsd)} USD API ${usagePeriod}</text>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="rei-q · ${total} contributions in the last year${totalTk ? ` · ${compact(totalTk)} tokens ${usagePeriod}` : ""} · ${EMAILS.join(" · ")}">
<style>
.li text{font:${CELL}px Consolas,'DejaVu Sans Mono',Menlo,monospace;white-space:pre}
.li0{fill:${t.li[0]}}.li1{fill:${t.li[1]}}.li2{fill:${t.li[2]}}
${skCss}
.sb{transform-box:fill-box;transform-origin:50% 100%;animation:g .9s cubic-bezier(.2,.7,.2,1) both}
@keyframes g{from{transform:scaleY(.02);opacity:0}to{transform:scaleY(1);opacity:1}}
${t.surf.map((c, i) => `.z${i}{fill:${c};stroke:${c}}`).join("")}
.srf polygon{stroke-width:.35;stroke-linejoin:round}
.srf{opacity:${t.surfOpacity};animation:fs 1.4s ease-out .9s both}
.axes{animation:f 1.4s ease-out .9s both}
@keyframes fs{from{opacity:0}to{opacity:${t.surfOpacity}}}
@keyframes f{from{opacity:0}to{opacity:1}}
.ax{fill:none;stroke:${t.axis};stroke-width:.8}
.pb{fill:none;stroke:${t.axis};stroke-width:.8;stroke-dasharray:2 2}
.axl{font-family:${FONT_UI};font-size:9.5px;font-variant:small-caps;letter-spacing:.6px;fill:${t.axis}}
.mail,.stat{font-family:${FONT_UI};font-variant:small-caps;letter-spacing:2px}
.mail{font-size:22px;fill:${t.mail}}
.stat{font-size:20px;fill:${t.stat}}
@media (prefers-reduced-motion:reduce){.sb,.srf,.axes{animation:none}}
</style>
<defs>
<g id="blob" class="li"><g class="li0">${spriteRows[0].join("")}</g><g class="li1">${spriteRows[1].join("")}</g><g class="li2">${spriteRows[2].join("")}</g></g>
<path id="bn-curve" d="${bd}" fill="none"/>
</defs>
<g class="bg">
${blobs}
</g>
<svg x="0" y="${BANNER.y}" width="${W}" height="${BANNER.h}" viewBox="260 0 860 100" overflow="hidden">
<text font-family="'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif" font-size="50" font-weight="700" letter-spacing="1.5" fill="${t.banner[0]}" fill-opacity="${t.banner[1]}" textLength="${UNIT * REPS}" lengthAdjust="spacing"><textPath href="#bn-curve" startOffset="0">${bannerText}<animate attributeName="startOffset" from="0" to="-${UNIT}" dur="${(UNIT / 75).toFixed(2)}s" repeatCount="indefinite"/></textPath></text>
</svg>
<svg x="${SKY.x}" y="${SKY.y}" width="${SKY.w}" height="${SKY.h}" viewBox="0 0 ${SKW.toFixed(1)} ${SKH.toFixed(1)}" overflow="visible">
${skylineBody}
</svg>
${statRow}
${mails}
</svg>
`;
}

const THEMES = {
  dark: { li: ["#363636", "#575757", "#7c7c7c"], sky: ["#1e1e1e", "#3c3c3c", "#626262", "#8e8e8e", "#cfcfcf"], banner: ["#e6edf3", 0.16], mail: "#9a9a9a", stat: "#7a7a7a", axis: "#6e6e6e", surf: ["#5a5a5a", "#787878", "#969696", "#b4b4b4", "#d2d2d2", "#f0f0f0"], surfOpacity: 0.34 },
  light: { li: ["#e2e2e2", "#c8c8c8", "#a8a8a8"], sky: ["#ececec", "#cdcdcd", "#a3a3a3", "#6c6c6c", "#2b2b2b"], banner: ["#1f2328", 0.14], mail: "#6a6a6a", stat: "#8a8a8a", axis: "#8c8c8c", surf: ["#b0b0b0", "#8c8c8c", "#6a6a6a", "#4a4a4a", "#2c2c2c", "#111111"], surfOpacity: 0.3 },
};
for (const [name, t] of Object.entries(THEMES)) writeFileSync(join(outDir, `card-${name}.svg`), card(t));
console.log(JSON.stringify({ total, totalTk, totalUsd: Math.round(totalUsd), period: usagePeriod, partial: runs, kb: Math.round(card(THEMES.dark).length / 1024) }));
