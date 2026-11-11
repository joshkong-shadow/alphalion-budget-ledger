#!/usr/bin/env node
/* Budget Bucket Ledger — Moby pull (brand-agnostic; all settings come from the project's ledger.config.json).
   Writes one compact file per day to <project>/data/raw/. Each file holds, for every campaign and ad set
   Moby returns for that day: spend ON that day, plus budget and on/off status AS OF THE MOMENT OF THE
   PULL (Moby keeps no budget or status history).
   Usage:
     node fetch_moby.mjs --project <folder>                        # today + the 2 days before (daily refresh)
     node fetch_moby.mjs --project <folder> 2026-09-05 2026-10-05  # explicit range (backfill)
     node fetch_moby.mjs --project <folder> --visits-only <start> <end>  # visitor counts only (NVP backfill)
   Key: the file named by `moby_key_file` in the config (default ~/.config/moby/key), or MOBY_MCP_KEY. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const pi = argv.indexOf('--project');
if (pi < 0 || !argv[pi + 1]) { console.error('Usage: fetch_moby.mjs --project <folder> [start end]'); process.exit(1); }
const ROOT = resolve(argv[pi + 1]); argv.splice(pi, 2);
const cfg = JSON.parse(readFileSync(join(ROOT, 'ledger.config.json'), 'utf8'));
const RAW = join(ROOT, 'data', 'raw');
const ENDPOINT = cfg.moby_endpoint || 'https://api.mobybots.com/v2/mcp';
const CHANNEL = cfg.channel || 'meta';
const TZ = cfg.timezone; // the Moby tenant's reporting timezone
const TRAILING = 3;
// NC revenue keeps maturing for the attribution window, so the default run also re-pulls the
// performance file (data/visits/) for every day inside the NVP window.
const TRAILING_PERF = (cfg.nvp_window_days || 8) + (cfg.nvp_offset_days ?? 0) + 1;
const MODEL = cfg.attribution_model || 'full_impact', WINDOW = cfg.attribution_window || '7_day_click';
// --visits-only: write just the new/recurring visitor counts to data/visits/ and leave data/raw/ alone.
// Use it to backfill the NVP split without overwriting the budgets and on/off states earlier pulls recorded.
const VISITS_ONLY = argv.includes('--visits-only'); if (VISITS_ONLY) argv.splice(argv.indexOf('--visits-only'), 1);

function key() {
  if (process.env.MOBY_MCP_KEY) return process.env.MOBY_MCP_KEY.trim();
  const f = (cfg.moby_key_file || '~/.config/moby/key').replace(/^~/, homedir());
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  console.error(`No Moby key: set MOBY_MCP_KEY or create ${f}`); process.exit(1);
}
const KEY = key();
let rpcId = 1;

async function callTool(name, args, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 120_000);
      const res = await fetch(ENDPOINT, {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
      });
      clearTimeout(t);
      const text = await res.text();
      const m = text.match(/data: (.*)/);
      if (!m) throw new Error(`no data frame (status ${res.status}): ${text.slice(0, 120)}`);
      const parsed = JSON.parse(m[1]);
      if (parsed.error) throw new Error(`rpc error: ${JSON.stringify(parsed.error).slice(0, 200)}`);
      return parsed.result.structuredContent.result;
    } catch (e) {
      console.error(`  attempt ${i}/${tries} failed: ${e.message}`);
      if (i === tries) throw e;
      await new Promise(r => setTimeout(r, 3000 * i));
    }
  }
}

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = v => Math.round(v * 100) / 100;

async function fetchDay(date, perfOnly = VISITS_ONLY) {
  const res = await callTool('get_channel_campaign_performance', {
    channel: CHANNEL, startDate: date, endDate: date, attributionModel: MODEL, attributionWindow: WINDOW,
  });
  const campaigns = res.map(c => {
    const adsets = (c.adsets || []).map(a => ({
      id: a.id, name: a.name, status: a.status, budget: a.budget ?? null, budgetType: a.budgetType ?? null,
      spend: r2((a.ads || []).reduce((s, ad) => s + num(ad.spend), 0)),
      activeAds: (a.ads || []).filter(ad => ad.status === 'ACTIVE').length,
      // visitor counts feed the NVP split (new ÷ (new + recurring), same formula as the NV% report)
      nv: (a.ads || []).reduce((s, ad) => s + num(ad.newVisitorCount), 0),
      rv: (a.ads || []).reduce((s, ad) => s + num(ad.recurringVisitorCount), 0),
      // new-customer revenue under the configured attribution (NC RoAS = this ÷ spend)
      ncr: r2((a.ads || []).reduce((s, ad) => s + num(ad.newCustomerRevenue ?? ad.acquisitionRevenue), 0)),
    }));
    const account = ((c.adsets || [])[0]?.ads || [])[0]?.accountId ?? null;
    return { id: c.id, name: c.name, account, status: c.status, budget: c.budget ?? null, budgetType: c.budgetType ?? null,
      spend: r2(adsets.reduce((s, a) => s + a.spend, 0)), adsets };
  });
  // Performance file: per ad set [new visitors, recurring visitors, spend, NC revenue]. Written on every pull;
  // the NVP split reads it. --visits-only writes only this and leaves data/raw/ (recorded budgets) alone.
  const dir = join(ROOT, 'data', 'visits'); mkdirSync(dir, { recursive: true });
  const perf = {};
  for (const c of campaigns) for (const a of c.adsets) if (a.nv || a.rv || a.spend || a.ncr) perf[a.id] = [a.nv, a.rv, a.spend, a.ncr];
  // Per creative (ad), for the NV% report's method: each ad is bucketed on its own NVP.
  const ads = {};
  for (const c of res) for (const a of c.adsets || []) for (const ad of a.ads || []) {
    const v = [a.id, num(ad.newVisitorCount), num(ad.recurringVisitorCount), r2(num(ad.spend)), r2(num(ad.newCustomerRevenue ?? ad.acquisitionRevenue))];
    if (v[1] || v[2] || v[3] || v[4]) ads[ad.id] = v;
  }
  writeFileSync(join(dir, `${date}.json`), JSON.stringify({ date, pulledAt: new Date().toISOString(), model: MODEL, window: WINDOW, fields: ['new_visitors', 'recurring_visitors', 'spend', 'nc_revenue'], adsets: perf, ad_fields: ['adset_id', 'new_visitors', 'recurring_visitors', 'spend', 'nc_revenue'], ads }));
  if (perfOnly) { console.log(`  ${date}: performance for ${Object.keys(perf).length} ad sets`); return; }
  mkdirSync(RAW, { recursive: true });
  writeFileSync(join(RAW, `${date}.json`), JSON.stringify({ date, pulledAt: new Date().toISOString(), campaigns }));
  console.log(`  ${date}: ${campaigns.length} campaigns, spend ${Math.round(campaigns.reduce((s, c) => s + c.spend, 0))}`);
}

const laToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

let [start, end] = argv;
if (!start) { end = laToday(); start = addDays(end, -(TRAILING - 1)); }
if (!end) end = start;
console.log(`Moby pull ${start} .. ${end}`);
for (let d = start; d <= end; d = addDays(d, 1)) await fetchDay(d);
if (!argv.length && !VISITS_ONLY) { // daily refresh: also re-pull maturing performance for the rest of the NVP window
  const pStart = addDays(end, -(TRAILING_PERF - 1));
  for (let d = pStart; d < start; d = addDays(d, 1)) await fetchDay(d, true);
}
