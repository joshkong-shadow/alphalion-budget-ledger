#!/usr/bin/env node
/* Budget ledger — build. Turns data/raw (Moby pulls) + budget history into the four
   documents the artifact page reads (data/artifact/{meta,daily,weekly,monthly,detail}.json).

   THE RULE (one sentence): a day's budget = the daily budgets of the campaigns (CBO) and ad sets
   (ABO) that were switched ON when the day ended; utilization = that funnel's spend ÷ that budget.
   Today = what is on right now. Past days = that night's snapshot if one exists, otherwise rebuilt
   from spend (on = spent that day and the next) + Meta's budget change history (data/budgetlog).

   Usage (always pass --project <folder>):
     node build_ledger.mjs --project P init --brand "Brand" --funnels B2O,SHT,DEL --timezone America/Los_Angeles
     node build_ledger.mjs --project P             # build data/artifact/*.json
     node build_ledger.mjs --project P snapshot    # record how the day ended (when the pull qualifies), then build
     node build_ledger.mjs --project P page        # write artifact/budget-ledger.html from the skill's template
     node build_ledger.mjs --project P record-versions '<json>'  # store versions returned by a database write */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf('--' + name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const project = flag('project');
if (!project) { console.error('Usage: build_ledger.mjs --project <folder> [init|snapshot|page]'); process.exit(1); }
const ROOT = resolve(project);
const D = p => join(ROOT, 'data', p);
const CMD = argv[0] || 'build';

if (CMD === 'init') {
  const brand = flag('brand'), funnels = (flag('funnels') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean), tz = flag('timezone') || 'America/Los_Angeles';
  if (!brand || !funnels.length) { console.error('init needs --brand "<Brand>" and --funnels A,B,C'); process.exit(1); }
  for (const d of ['data/raw', 'data/budgetlog', 'data/snapshots', 'data/artifact', 'artifact']) mkdirSync(join(ROOT, d), { recursive: true });
  if (!existsSync(join(ROOT, '.gitignore'))) writeFileSync(join(ROOT, '.gitignore'), 'data/\n.env\n');
  const cfgPath = join(ROOT, 'ledger.config.json');
  if (existsSync(cfgPath)) { console.error('ledger.config.json already exists — edit it instead.'); process.exit(1); }
  writeFileSync(cfgPath, JSON.stringify({ brand, timezone: tz, channel: 'meta', moby_key_file: '~/.config/moby/key', funnels, ledger_start: null,
    keep: { daily: 120, weekly: 26, monthly: 12, detail_days: 21 }, page_title: `${brand} Budget Ledger`, page_note: '' }, null, 2) + '\n');
  console.log(`Project ready at ${ROOT}. Set ledger_start (a Monday) in ledger.config.json before the first build.`);
  process.exit(0);
}

const cfg = JSON.parse(readFileSync(join(ROOT, 'ledger.config.json'), 'utf8'));

if (CMD === 'record-versions') {
  // After a successful database write, store the versions it returned, e.g.
  //   build_ledger.mjs --project P record-versions '{"budget/meta":31,"ledger_nvp/nvp-2026-10-18":4}'
  const f = join(ROOT, 'data', 'artifact', 'versions.json');
  const cur = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  const add = JSON.parse(argv[1] || '{}');
  for (const [k, v] of Object.entries(add)) if (/^[a-z_]+\/[A-Za-z0-9_.-]+$/.test(k) && Number.isInteger(v)) cur[k] = v;
  mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(cur, null, 1));
  console.log(`versions recorded: ${Object.keys(add).length} (now tracking ${Object.keys(cur).length})`);
  process.exit(0);
}

if (CMD === 'page') {
  const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = readFileSync(join(SKILL, 'assets', 'budget-ledger.template.html'), 'utf8')
    .replaceAll('{{PAGE_TITLE}}', esc(cfg.page_title || `${cfg.brand} Budget Ledger`))
    .replaceAll('{{BRAND}}', esc(cfg.brand))
    .replaceAll('{{FUNNELS_JSON}}', JSON.stringify(cfg.funnels));
  mkdirSync(join(ROOT, 'artifact'), { recursive: true });
  writeFileSync(join(ROOT, 'artifact', 'budget-ledger.html'), html);
  console.log(`page written: ${join(ROOT, 'artifact', 'budget-ledger.html')}`);
  process.exit(0);
}
const FUNNELS = cfg.funnels;            // ["B2O","SHT","DEL"]
const START = cfg.ledger_start || '0000-00-00'; // first day the ledger shows
const r2 = v => Math.round(v * 100) / 100;
const laToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date());

const funnelOf = name => {
  const f = String(name || '').split('|')[0].trim().toUpperCase();
  return FUNNELS.includes(f) ? f : 'OTH';
};

// ---------- load raw days ----------
const rawFiles = readdirSync(D('raw')).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
const days = rawFiles.map(f => JSON.parse(readFileSync(D('raw/' + f), 'utf8')));

// Every budget-holding entity, with its budget as of the freshest pull that mentions it.
// CBO campaign → the campaign holds the budget. ABO → each ad set holds its own.
const current = new Map(); // id -> { budget, type, pulledAt }
const holdersOf = c => (c.budget != null
  ? [{ id: c.id, kind: 'campaign', name: c.name, budget: c.budget, type: c.budgetType, spend: c.spend }]
  : c.adsets.filter(a => a.budget != null).map(a => ({ id: a.id, kind: 'adset', name: a.name, budget: a.budget, type: a.budgetType, spend: a.spend })));
for (const day of days) for (const c of day.campaigns) for (const h of holdersOf(c)) {
  const prev = current.get(h.id);
  if (!prev || day.pulledAt >= prev.pulledAt) current.set(h.id, { budget: h.budget, type: h.type, pulledAt: day.pulledAt });
}

// ---------- budget change history (Meta activity log) ----------
function parseDt(s) { // "10/4/2026 at 9:53 AM" (ad-account local time)
  const m = String(s).replace(/[  ]/g, ' ').match(/(\d+)\/(\d+)\/(\d{4}) at (\d+):(\d+)\s*([AP]M)/i);
  if (!m) return null;
  let h = Number(m[4]) % 12; if (/pm/i.test(m[6])) h += 12;
  const date = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return { date, min: h * 60 + Number(m[5]) };
}
const events = new Map(); // id -> [{date,min,old,new}] ascending
const logIssues = [];
let logCount = 0, lifetimeEvents = 0;
const seen = new Set();
const endMismatch = [];
if (existsSync(D('budgetlog'))) for (const f of readdirSync(D('budgetlog')).filter(f => f.endsWith('.jsonl'))) {
  const lines = readFileSync(D('budgetlog/' + f), 'utf8').split('\n').filter(Boolean);
  lines.forEach((line, i) => {
    const e = JSON.parse(line); const t = parseDt(e.dt);
    if (/billed/i.test(e.ev || '')) return;                       // billing events share the category; not budgets
    const sig = `${e.id}|${e.dt}|${e.old}|${e.new}`;              // the same event can arrive from overlapping pulls
    if (seen.has(sig)) return; seen.add(sig);
    if (!t || (e.old == null && e.new == null)) { logIssues.push(`unparsed ${f}:${i + 1}`); return; }
    if (/lifetime/i.test(e.per || '')) lifetimeEvents++;
    logCount++;
    if (!events.has(e.id)) events.set(e.id, []);
    events.get(e.id).push({ ...t, old: e.old == null ? null : e.old / 100, new: e.new == null ? null : e.new / 100 });
  });
}
// Order each entity's events oldest → newest. The log only resolves to the minute, so within
// a tied minute follow the chain (an event's "old" value is the previous event's "new").
for (const [id, list] of events) {
  list.sort((a, b) => a.date.localeCompare(b.date) || a.min - b.min);
  for (let i = 0; i < list.length; i++) {
    let j = i; while (j + 1 < list.length && list[j + 1].date === list[i].date && list[j + 1].min === list[i].min) j++;
    if (j > i) {
      const pool = list.slice(i, j + 1); const out = []; let prev = i > 0 ? list[i - 1].new : null;
      while (pool.length) {
        let k = pool.findIndex(e => prev != null && e.old === prev);
        if (k < 0) k = pool.findIndex(e => !pool.some(o => o !== e && o.new === e.old)); // chain head
        if (k < 0) k = 0;
        prev = pool[k].new; out.push(pool.splice(k, 1)[0]);
      }
      list.splice(i, out.length, ...out); i = j;
    }
  }
  for (let i = 1; i < list.length; i++) if (list[i].old !== list[i - 1].new) logIssues.push(`chain break ${id} ${list[i].date}: ${list[i - 1].new} → old ${list[i].old}`);
  const cur = current.get(id);
  if (cur && list.length && Math.abs(list[list.length - 1].new - cur.budget) > 0.011) endMismatch.push(`latest change ≠ Moby now ${id}: log ${list[list.length - 1].new} vs Moby ${cur.budget}`);
}
const logDates = [...events.values()].flat().map(e => e.date).sort();
const coverage = existsSync(D('budgetlog/coverage.json')) ? JSON.parse(readFileSync(D('budgetlog/coverage.json'), 'utf8')) : {};
const logFrom = coverage.from || logDates[0] || null;      // first day the change history covers in full
const logThrough = coverage.through || logDates[logDates.length - 1] || null; // last day it covers in full
// A budget that differs from the last logged change only signals a gap while the history is current;
// once pulls run past its coverage, later changes are expected.
const newestPull = days.map(d => d.pulledAt).sort().pop() || '';
const pullDay = newestPull ? new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date(newestPull)) : '';
if (logThrough && pullDay <= logThrough) logIssues.push(...endMismatch);

function budgetAtEnd(id, day) { // the budget the entity carried when `day` ended
  const list = events.get(id);
  if (!list) return null;
  let last = null;
  for (const e of list) { if (e.date <= day) last = e; else break; }
  return last ? last.new : list[0].old; // every change is later → the value before the first change
}

// ---------- snapshots (exact record of what was switched on, taken late in the day) ----------
const nextDayOf = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const isOn = (c, h) => c.status === 'ACTIVE' && h.status === 'ACTIVE';
const withStatus = c => (c.budget != null
  ? [{ id: c.id, status: c.status, budget: c.budget, type: c.budgetType, spend: c.spend }]
  : c.adsets.filter(a => a.budget != null).map(a => ({ id: a.id, status: a.status, budget: a.budget, type: a.budgetType, spend: a.spend })));
mkdirSync(D('snapshots'), { recursive: true });
if (CMD === 'snapshot') {
  // Moby reports on/off and budget as they are at the moment of the pull. A pull tells us how day D
  // ENDED when it happens late on D (9pm Pacific or later) or early the next morning (before 7am
  // Pacific, i.e. before the team's morning budget changes). Schedule the daily run inside that early-morning window.
  const la = iso => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(iso)).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 }; };
  let wrote = 0;
  for (const day of days) {
    const at = la(day.pulledAt);
    const valid = (at.date === day.date && at.hour >= 21) || (at.date === nextDayOf(day.date) && at.hour < 7);
    if (!valid) continue;
    const snap = {};
    for (const c of day.campaigns) for (const h of withStatus(c)) snap[h.id] = { budget: h.budget, type: h.type, on: isOn(c, h) };
    writeFileSync(D(`snapshots/${day.date}.json`), JSON.stringify({ date: day.date, takenAt: day.pulledAt, endOfDay: true, budgets: snap }));
    console.log(`snapshot ${day.date}: ${Object.keys(snap).length} budgets recorded (pulled ${at.date} ${at.hour}:00 Pacific)`); wrote++;
  }
  if (!wrote) console.log('snapshot: no day qualified (pull was not late evening or early morning Pacific) — past days stay rebuilt');
}
const snapshots = new Map(readdirSync(D('snapshots')).filter(f => f.endsWith('.json')).map(f => {
  const s = JSON.parse(readFileSync(D('snapshots/' + f), 'utf8')); return [s.date, s];
}).filter(([, s]) => s.endOfDay));

// ---------- per-day ledger ----------
// THE RULE: a day's budget = the daily budgets of the campaigns (CBO) and ad sets (ABO) that were
// SWITCHED ON when the day ended — not everything that spent at some point during the day.
//   today            → what is switched on right now, at its current budget (Moby)
//   past, snapshot   → exactly what was on in that night's snapshot
//   past, no snapshot→ rebuilt: "still on at day end" = it spent that day AND the next day;
//                      its budget = the value it ended the day on (Meta's budget change history)
const KEYS = ['t', ...FUNNELS, 'OTH'];
const FIELDS = ['spend', 'budget', 'holders'];
const zero = () => Object.fromEntries(KEYS.map(k => [k, [0, 0, 0]]));
const daily = [], detail = {}, otherNames = new Set();
// A budget is "BOFU" when its ad set name or its campaign name contains this text (any capitalisation).
const BOFU_RE = new RegExp(String(cfg.bofu_match || 'BOFU').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
let lifetimeHolders = 0;
const today = laToday();
const byDate = new Map(days.map(d => [d.date, d]));
const nextDay = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
const spentIds = day => { const s = new Set(); if (day) for (const c of day.campaigns) for (const h of withStatus(c)) if (h.spend > 0) s.add(h.id); return s; };
const lastRaw = days.map(d => d.date).filter(d => d <= today).sort().pop();

for (const day of days) {
  if (day.date < START || day.date > today) continue;
  const row = zero(); const onHolders = []; let est = 0, all = 0;
  const snap = snapshots.get(day.date);
  const isLatest = day.date === lastRaw;
  const tomorrow = byDate.get(nextDay(day.date));
  const stillSpending = spentIds(tomorrow);
  const mode = isLatest ? 'now' : snap ? 'snapshot' : 'rebuilt';
  for (const c of day.campaigns) {
    const f = funnelOf(c.name);
    let cBudget = 0, cHolders = 0;
    for (const h of withStatus(c)) {
      if (h.type && h.type !== 'daily') { if (h.spend > 0) lifetimeHolders++; continue; }
      let on, b;
      if (mode === 'now') { on = isOn(c, h); b = h.budget; }
      else if (mode === 'snapshot') { const s = snap.budgets[h.id]; on = !!(s && s.on); b = s ? s.budget : 0; }
      else {
        on = h.spend > 0 && stillSpending.has(h.id);
        const covered = logFrom && day.date >= logFrom && day.date <= logThrough;
        b = covered ? budgetAtEnd(h.id, day.date) : null;
        if (b == null) { b = h.budget; if (!covered) est += on ? b : 0; } // no change on record inside coverage → today's value held all along
      }
      if (!on) continue;
      all += b; cBudget += b; cHolders++;
      const hName = c.budget != null ? c.name : (c.adsets.find(x => x.id === h.id) || {}).name || '';
      onHolders.push({ id: h.id, f, b, cbo: c.budget != null, campaign: c.id, name: hName, campaignName: c.name, bofu: BOFU_RE.test(hName) || BOFU_RE.test(c.name) });
    }
    if (c.spend <= 0 && cHolders === 0) continue;
    if (f === 'OTH') otherNames.add(String(c.name).split('|')[0].trim());
    for (const k of ['t', f]) { row[k][0] += c.spend; row[k][1] += cBudget; row[k][2] += cHolders; }
  }
  for (const k of KEYS) row[k] = [r2(row[k][0]), r2(row[k][1]), row[k][2]];
  daily.push({ p: day.date, ...row, est: all > 0 ? r2(est / all) : 0, live: day.date === today ? 1 : 0, mode });
  detail[day.date] = onHolders;
}
daily.sort((a, b) => b.p.localeCompare(a.p));

// ---------- budgets split by NVP (the day's drop-down) ----------
// Each switched-on budget is scored by the New Visitor % of what it bought over a trailing window
// (default 8 days = that day and the 7 before, e.g. Sunday to Sunday), using the NV% report's formula:
// NVP = new visitors ÷ (new + recurring visitors), from Moby's per-ad visitor counts.
// An ABO budget is scored on its ad set; a CBO budget on all of its campaign's ad sets.
// Window the drop-down reads: `nvp_window_days` days ending `nvp_offset_days` before the day.
// Alpha Lion (Josh, 2026-10-19): 1 day, offset 1 = each day's budgets bucketed on the PREVIOUS day alone.
const NVP_WINDOW = cfg.nvp_window_days || 8;
const NVP_OFFSET = cfg.nvp_offset_days ?? 0;
const BUCKETS = ['b60', 'b50', 'b40', 'b0', 'none'];
const bucketFor = (nv, rv) => { const v = nv + rv; if (v <= 0) return 'none'; const p = nv / v; return p >= 0.6 ? 'b60' : p >= 0.5 ? 'b50' : p >= 0.4 ? 'b40' : 'b0'; };
const visitsCache = new Map();
function visitsOn(date) { // { adsetId: [new, recurring] } or null when that day has no visitor data
  if (visitsCache.has(date)) return visitsCache.get(date);
  let out = null;
  const f = D(`visits/${date}.json`);
  if (existsSync(f)) out = JSON.parse(readFileSync(f, 'utf8')).adsets; // [new, recurring, spend, nc revenue] (older files: first two only)
  else { const day = byDate.get(date); if (day && day.campaigns.some(c => c.adsets.some(a => 'nv' in a))) { out = {}; for (const c of day.campaigns) for (const a of c.adsets) if (a.nv || a.rv || a.spend) out[a.id] = [a.nv || 0, a.rv || 0, a.spend || 0, a.ncr || 0]; } }
  visitsCache.set(date, out); return out;
}
const adsCache = new Map();
function adsOn(date) { // { adId: [adsetId, new, recurring, spend, nc revenue] } or null when that day has no per-ad data
  if (adsCache.has(date)) return adsCache.get(date);
  const f = D(`visits/${date}.json`); let out = null;
  if (existsSync(f)) { const j = JSON.parse(readFileSync(f, 'utf8')); if (j.ads) out = j.ads; }
  adsCache.set(date, out); return out;
}
const campaignAdsets = new Map(); // campaign id → every ad set id seen under it
for (const day of days) for (const c of day.campaigns) { if (!campaignAdsets.has(c.id)) campaignAdsets.set(c.id, new Set()); for (const a of c.adsets) campaignAdsets.get(c.id).add(a.id); }
const adsetFunnel = new Map(); // ad set id → funnel, from the campaign names in the raw pulls
for (const day of days) for (const c of day.campaigns) { const f = funnelOf(c.name); for (const a of c.adsets) adsetFunnel.set(a.id, f); }
const adsetName = new Map(); for (const day of days) for (const c of day.campaigns) for (const a of c.adsets) adsetName.set(a.id, a.name);
const prevDay = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
function nvpSplit(date) {
  // Budget-level method (Josh, 2026-10-19): each switched-on budget gets ONE New Visitor %, blended from
  // all of its creatives — new ÷ (new + returning) visitors summed over its ad set (CBO: every ad set in
  // the campaign) across the basis window (Alpha Lion: the previous day). The whole budget lands in that
  // bucket. A budget launched that day has no previous-day visits, so it is scored on the day itself
  // instead (counted in `same_day`), never left as "no data".
  let start = date; for (let i = 0; i < NVP_OFFSET; i++) start = prevDay(start);
  const win = []; for (let d = start, i = 0; i < NVP_WINDOW; i++, d = prevDay(d)) win.push(d);
  const maps = win.map(visitsOn).filter(Boolean);
  if (!maps.length) return null;
  const hasRevenue = maps.every(m => Object.values(m).every(v => v.length >= 4));
  const out = { from: win[win.length - 1], to: win[0], days_with_data: maps.length, window_days: NVP_WINDOW, offset_days: NVP_OFFSET, nc_roas: hasRevenue, method: 'budget' };
  const blank = () => [0, 0, 0, 0, 0, 0]; // budget, budgets counted, new visitors, all visitors, spend, NC revenue
  for (const k of KEYS) { out[k] = Object.fromEntries(BUCKETS.map(b => [b, blank()])); for (const b of BUCKETS) { out[k][b + '_bofu'] = blank(); out[k][b + '_rest'] = blank(); } out[k].same_day = [0, 0]; }
  const sameDay = visitsOn(date);
  const items = [];
  for (const h of detail[date] || []) {
    const ids = h.cbo ? [...(campaignAdsets.get(h.campaign) || [])] : [h.id];
    const sum = ms => { let nv = 0, rv = 0, sp = 0, nr = 0; for (const m of ms) for (const id of ids) { const v = m[id]; if (v) { nv += v[0]; rv += v[1]; sp += v[2] || 0; nr += v[3] || 0; } } return [nv, rv, sp, nr]; };
    let [nv, rv, sp, nr] = sum(maps), fallback = false;
    if (nv + rv <= 0 && sameDay) { [nv, rv, sp, nr] = sum([sameDay]); fallback = nv + rv > 0; }
    const b = bucketFor(nv, rv);
    const add = x => { x[0] += h.b; x[1]++; x[2] += nv; x[3] += nv + rv; x[4] += sp; x[5] += nr; };
    // one line per budget for the drill-down; a campaign-level budget lists its ad sets underneath
    const pct = (n, r) => (n + r > 0 ? Math.round(n / (n + r) * 1000) / 10 : null);
    const basis = fallback ? [sameDay] : maps;
    const kids = h.cbo ? ids.map(id => { let a = 0, b2 = 0, s2 = 0, r2_ = 0; for (const m of basis) { const v = m[id]; if (v) { a += v[0]; b2 += v[1]; s2 += v[2] || 0; r2_ += v[3] || 0; } } return [adsetName.get(id) || id, pct(a, b2), r2(s2), r2(r2_)]; }).filter(k => k[2] > 0 || k[1] != null).sort((x, y) => y[2] - x[2]) : [];
    items.push([h.f, b, h.bofu ? 1 : 0, h.cbo ? 'CBO' : 'ABO', h.name, r2(h.b), pct(nv, rv), r2(sp), r2(nr), fallback ? 1 : 0, kids]);
    for (const k of ['t', h.f]) { add(out[k][b]); add(out[k][b + (h.bofu ? '_bofu' : '_rest')]); if (fallback) { out[k].same_day[0] += h.b; out[k].same_day[1]++; } }
  }
  for (const k of KEYS) for (const b of Object.keys(out[k])) out[k][b] = out[k][b].map((v, i) => (i === 0 || i >= 4 ? r2(v) : v));
  out._items = items.sort((x, y) => y[5] - x[5]);
  // That day alone, for the day row's NC RoAS: every ad set's spend and NC revenue on `date`, by funnel.
  const today = visitsOn(date);
  if (today && date !== laToday()) { // the day still running gets no NC RoAS until the next run
    const day = Object.fromEntries(KEYS.map(k => [k, [0, 0]]));
    for (const [id, v] of Object.entries(today)) { const f = adsetFunnel.get(id) || 'OTH'; for (const k of ['t', f]) { day[k][0] += v[2] || 0; day[k][1] += v[3] || 0; } }
    out.day = Object.fromEntries(KEYS.map(k => [k, [r2(day[k][0]), r2(day[k][1])]]));
  }
  return out;
}

// ---------- weekly (Mon–Sun) and monthly roll-ups ----------
const monday = d => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
function rollup(keyOf) {
  const m = new Map();
  for (const r of daily) {
    const k = keyOf(r.p); if (!m.has(k)) m.set(k, { p: k, ...zero(), days: 0, est: 0 });
    const o = m.get(k); o.days++; o.est = Math.max(o.est, r.est);
    for (const key of KEYS) for (let i = 0; i < 3; i++) o[key][i] = r2(o[key][i] + r[key][i]);
  }
  return [...m.values()].sort((a, b) => b.p.localeCompare(a.p));
}
const keep = cfg.keep;
// ---------- documents for the artifact database ----------
// Small documents so a daily refresh can pass them INLINE (no local-file send, which the desktop app
// asks to approve on every scheduled run):
//   budget/meta                 settings + labels
//   ledger_daily/daily-YYYY-MM  one month of daily rows (weekly / monthly rows are rolled up by the page)
//   ledger_nvp/nvp-YYYY-MM-DD   one day's budgets-by-NVP split
// Every doc carries `check` = the sum of all its numbers; the page recomputes it and warns on a mismatch,
// which catches a document garbled in transit.
const DETAIL = { kind: 'nvp', fields: ['budget', 'holders', 'new_visitors', 'visitors', 'spend', 'nc_revenue'], attribution: `${cfg.attribution_model || 'full_impact'} · ${cfg.attribution_window || '7_day_click'}`, bofu_match: cfg.bofu_match || 'BOFU', bofu_label: cfg.bofu_label || null, bofu_label_rest: cfg.bofu_label_rest || null, buckets: BUCKETS, window_days: NVP_WINDOW, offset_days: NVP_OFFSET };
const sumNumbers = o => { let t = 0; const walk = v => { if (typeof v === 'number' && Number.isFinite(v)) t += v; else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(o); return Math.round(t * 100) / 100; };
const withCheck = o => ({ ...o, check: sumNumbers(o) });
const docs = [];
docs.push({ collection: 'budget', id: 'meta', data: withCheck({
  brand: cfg.brand, generated_at: new Date().toISOString(), timezone: cfg.timezone, funnels: FUNNELS,
  other_funnels: [...otherNames].sort(), ledger_start: START, log_from: logFrom, log_through: logThrough, source: 'Moby (Meta campaigns and ad sets)',
  first_snapshot: [...snapshots.keys()].sort()[0] || null, rule: 'on_at_day_end', note: cfg.page_note || '', channel: cfg.channel || 'meta',
  layout: 'chunks', daily_fields: FIELDS, detail: DETAIL, keep }) });
const months = new Map();
for (const r of daily.slice(0, keep.daily)) { const m = r.p.slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m).push(r); }
for (const [m, rows] of months) docs.push({ collection: 'ledger_daily', id: `daily-${m}`, data: withCheck({ month: m, rows }) });
for (const r of daily.slice(0, keep.detail_days)) {
  const x = nvpSplit(r.p); if (!x) continue;
  const { _items, ...split } = x;
  docs.push({ collection: 'ledger_nvp', id: `nvp-${r.p}`, data: withCheck({ date: r.p, ...split }) });
  // drill-down lines: [funnel, bucket, bofu, type, name, budget, nvp %, basis spend, basis NC revenue, scored same day, ad sets[[name, nvp %, spend, NC revenue]]]
  docs.push({ collection: 'ledger_items', id: `items-${r.p}`, data: withCheck({ date: r.p, items: _items }) });
}

mkdirSync(D('artifact/docs'), { recursive: true });
for (const d of docs) writeFileSync(D(`artifact/docs/${d.collection}__${d.id}.json`), JSON.stringify(d.data));
// The refresh payload: meta, the month(s) and the NVP days that can still change (the NVP window plus
// one day, because NC revenue keeps maturing). `--all` (or a doc with no recorded version) sends everything.
const versionsFile = D('artifact/versions.json');
const versions = existsSync(versionsFile) ? JSON.parse(readFileSync(versionsFile, 'utf8')) : {};
const recent = new Set(daily.slice(0, cfg.payload_days || 2).map(r => r.p)); // today + yesterday; older days stay as written
const recentMonths = new Set([...recent].map(d => d.slice(0, 7)));
const sendAll = argv.includes('--all');
const keyOf = d => `${d.collection}/${d.id}`;
const chosen = docs.filter(d => sendAll || d.id === 'meta' || (d.collection === 'ledger_daily' && recentMonths.has(d.data.month)) || ((d.collection === 'ledger_nvp' || d.collection === 'ledger_items') && recent.has(d.data.date)));
const writes = chosen.map(d => ({ op: 'set', collection: d.collection, doc_id: d.id, ...(versions[keyOf(d)] ? { if_version: versions[keyOf(d)] } : {}), data: d.data }));
writeFileSync(D('artifact/payload.json'), JSON.stringify({ writes }));
console.log(`payload: ${writes.length} documents, ${(JSON.stringify(writes).length / 1024).toFixed(1)} KB → data/artifact/payload.json`);

// ---------- console report ----------
console.log(`budget log: ${logCount} changes on ${events.size} entities, from ${logFrom}; lifetime-budget changes ${lifetimeEvents}; lifetime holders skipped ${lifetimeHolders}`);
console.log(`log issues: ${logIssues.length}`); logIssues.slice(0, 25).forEach(s => console.log('  ' + s));
console.log('day         ' + KEYS.map(k => `${k.padStart(7)} spend/budget  util`).join(' | ') + ' | est');
for (const r of daily) console.log(r.p + '  ' + KEYS.map(k => `${String(Math.round(r[k][0])).padStart(7)}/${String(Math.round(r[k][1])).padStart(7)} ${(r[k][1] ? (r[k][0] / r[k][1] * 100).toFixed(0) + '%' : '—').padStart(5)}`).join(' | ') + ` | ${r.est}${r.live ? ' (today, partial)' : ''}`);
