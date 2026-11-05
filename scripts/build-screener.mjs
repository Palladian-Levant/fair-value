// Runs each night on GitHub. It values the largest US companies with the same
// model as the website, then writes the results for the screener page.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractCompany, mergeFacts, UnsupportedFilerError } from '../docs/js/extract.js';
import { addSectorMultiples, analyse } from '../docs/js/model.js';
import { sectorOf } from '../docs/js/sectors.js';

const SEC_GAP_MS = 150;
const FINNHUB_GAP_MS = 1050;
const CANDIDATES = 800;
const KEEP = 500;
const RETRIES = 3;
const LARGE_GAP = 1.5;
const DATA_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'data');
const OUTPUT = path.join(DATA_FOLDER, 'screener.json');
const COMPANIES_OUTPUT = path.join(DATA_FOLDER, 'companies.json');

// New holding companies start with no history at the SEC.
const PREDECESSORS = { '0002115436': '0000034088' }; // ExxonMobil

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseTreasury(xml) {
  const yields = [...xml.matchAll(/<d:BC_10YEAR[^>]*>([\d.]+)</g)].map(match => Number(match[1])).filter(v => v > 0);
  return yields.length ? yields.at(-1) / 100 : null;
}

export function pacedClient({ fetchImpl = fetch, sleep = wait, gapMs, headers }) {
  let last = 0;
  return async function request(url, parse = 'json') {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      const delay = last + gapMs - Date.now();
      if (delay > 0) await sleep(delay);
      last = Date.now();
      let response;
      try {
        response = await fetchImpl(url, { headers });
      } catch {
        if (attempt === RETRIES) throw new Error('network error');
        await sleep(2 ** attempt * 2000);
        continue;
      }
      if (response.ok) return response[parse]();
      const retry = response.status === 429 || response.status >= 500;
      if (!retry || attempt === RETRIES) {
        const error = new Error(`status ${response.status}`);
        error.status = response.status;
        throw error;
      }
      await sleep(2 ** attempt * 5000);
    }
    throw new Error('request failed');
  };
}

export function candidateList(tickers, limit = CANDIDATES) {
  const seen = new Set();
  const list = [];
  for (const row of Object.values(tickers)) {
    if (seen.has(row.cik_str)) continue;
    seen.add(row.cik_str);
    list.push({ cik: String(row.cik_str).padStart(10, '0'), ticker: row.ticker.toUpperCase(), title: row.title });
    if (list.length === limit) break;
  }
  return list;
}

export function rowFrom(candidate, analysis, price) {
  const { range, confidence, co, label, warnings } = analysis;
  const gap = range.base / price - 1;
  const flags = [];
  const suspicious = gap > LARGE_GAP;
  if (suspicious) flags.push('Unusually large gap');
  if (warnings.some(w => w.includes('out of date'))) flags.push('Old accounts');
  if (warnings.some(w => w.includes('share count'))) flags.push('Share count differed');
  if (co.ttm.netIncome < 0) flags.push('Recent loss');
  const round = value => Number(value.toFixed(2));
  return {
    ticker: candidate.ticker,
    name: analysis.market.companyName || co.name,
    sector: sectorOf(co.sic, candidate.ticker),
    label,
    price: round(price),
    fair: round(range.base),
    low: round(range.bear),
    high: round(range.bull),
    gap: Number(gap.toFixed(4)),
    confidence: suspicious ? 'Low' : confidence.level,
    score: confidence.score,
    cap: Math.round(price * analysis.market.sharesUsed),
    flags,
  };
}

async function latestRiskFree(request, now) {
  const year = now.getUTCFullYear();
  for (const y of [year, year - 1]) {
    const xml = await request(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${y}`, 'text');
    const rate = parseTreasury(xml);
    if (rate) return rate;
  }
  return undefined;
}

// Values every saved company. Sector multiples need the whole list first.
export function scoreCompanies(companies, { keep = KEEP, notValued = [] } = {}) {
  addSectorMultiples(companies);
  const rows = [];
  const missing = [...notValued];
  for (const [ticker, entry] of Object.entries(companies)) {
    const analysis = analyse(entry.co, entry.market);
    const sector = sectorOf(entry.co.sic, ticker);
    if (!analysis.fairValueAvailable) missing.push({ sector, reason: analysis.label });
    else if (!(analysis.range.base > 0)) missing.push({ sector, reason: 'Debts exceed estimated value' });
    else rows.push(rowFrom({ ticker }, analysis, entry.market.price));
  }
  rows.sort((a, b) => b.cap - a.cap);
  const counts = {};
  for (const { sector } of missing) counts[sector] = (counts[sector] ?? 0) + 1;
  return { notValued: counts, rows: rows.slice(0, keep) };
}

export async function buildScreener({ tickers, sec, finnhub, plain, now = new Date(), log = () => {}, keep = KEEP, limit = CANDIDATES }) {
  const today = now.toISOString().slice(0, 10);
  let riskFree;
  try {
    riskFree = await latestRiskFree(plain, now);
  } catch {
    log('Treasury yield unavailable, so the default will be used.');
  }

  const candidates = candidateList(tickers ?? await sec('https://www.sec.gov/files/company_tickers.json'), limit);
  const rows = [];
  const notValued = [];
  const companies = {};
  let failed = 0;

  for (const [index, candidate] of candidates.entries()) {
    if (index % 50 === 0) log(`${index} of ${candidates.length}`);
    const symbol = encodeURIComponent(candidate.ticker.replace('-', '.'));
    try {
      let facts = await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${candidate.cik}.json`);
      const predecessor = PREDECESSORS[candidate.cik];
      if (predecessor) facts = mergeFacts(facts, await sec(`https://data.sec.gov/api/xbrl/companyfacts/CIK${predecessor}.json`));
      const submissions = await sec(`https://data.sec.gov/submissions/CIK${candidate.cik}.json`);
      const company = extractCompany(facts, submissions);
      const quote = await finnhub(`https://finnhub.io/api/v1/quote?symbol=${symbol}`);
      const metric = await finnhub(`https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all`);
      const profile = await finnhub(`https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}`);
      const price = quote?.c > 0 ? quote.c : null;
      if (!price) { failed += 1; continue; }
      const market = {
        price,
        beta: typeof metric?.metric?.beta === 'number' ? metric.metric.beta : undefined,
        week52High: metric?.metric?.['52WeekHigh'],
        week52Low: metric?.metric?.['52WeekLow'],
        peHistory: (metric?.series?.annual?.pe ?? []).slice(0, 10).map(point => point.v),
        companyName: profile?.name,
        finnhubShares: profile?.shareOutstanding > 0 ? profile.shareOutstanding * 1e6 : undefined,
        marketCap: profile?.marketCapitalization > 0 ? profile.marketCapitalization * 1e6 : undefined,
        riskFree,
        today,
      };
      companies[candidate.ticker] = { co: company, market };
    } catch (error) {
      // Foreign shares and funds in the SEC's list often have no accounts there.
      if (error instanceof UnsupportedFilerError || error.status === 404) notValued.push({ sector: 'Other', reason: 'Accounts not readable' });
      else failed += 1;
    }
  }

  const scored = scoreCompanies(companies, { keep, notValued });
  return {
    generatedAt: now.toISOString(),
    attempted: candidates.length,
    failed,
    ...scored,
    companies,
  };
}

// A bad night must never replace good results.
export function isSafeToPublish(result, previousCount = 0, trial = false) {
  const answered = result.attempted - result.failed;
  if (trial) return result.rows.length ? { ok: true } : { ok: false, reason: 'no companies were valued' };
  if (result.rows.length < 50) return { ok: false, reason: `only ${result.rows.length} companies were valued` };
  if (answered < result.attempted * 0.7) return { ok: false, reason: `${result.failed} of ${result.attempted} companies failed` };
  if (previousCount && result.rows.length < previousCount * 0.7) return { ok: false, reason: `the list fell from ${previousCount} to ${result.rows.length}` };
  return { ok: true };
}

async function main() {
  const { SEC_CONTACT_EMAIL: contact, FINNHUB_API_KEY: key } = process.env;
  if (!contact || !key) {
    console.error('Add SEC_CONTACT_EMAIL and FINNHUB_API_KEY as repository secrets.');
    process.exit(1);
  }
  const sec = pacedClient({ gapMs: SEC_GAP_MS, headers: { 'User-Agent': `FairValueTool ${contact}`, Accept: 'application/json' } });
  const finnhub = pacedClient({ gapMs: FINNHUB_GAP_MS, headers: { 'X-Finnhub-Token': key } });
  const plain = pacedClient({ gapMs: 500, headers: { Accept: 'application/xml' } });

  const trialSize = Number(process.env.SCREEN_LIMIT) || 0;
  const result = await buildScreener({ sec, finnhub, plain, log: console.log, limit: trialSize || CANDIDATES });
  let previousCount = 0;
  try {
    previousCount = JSON.parse(await readFile(OUTPUT, 'utf8')).rows.length;
  } catch { /* first run */ }

  const check = isSafeToPublish(result, previousCount, trialSize > 0);
  if (!check.ok) {
    console.error(`Keeping the previous results because ${check.reason}.`);
    process.exit(1);
  }
  const { companies, ...screener } = result;
  await mkdir(DATA_FOLDER, { recursive: true });
  await writeFile(`${OUTPUT}.tmp`, JSON.stringify(screener));
  await writeFile(`${COMPANIES_OUTPUT}.tmp`, JSON.stringify({ generatedAt: result.generatedAt, companies }));
  await rename(`${OUTPUT}.tmp`, OUTPUT);
  await rename(`${COMPANIES_OUTPUT}.tmp`, COMPANIES_OUTPUT);
  console.log(`Saved ${result.rows.length} companies. ${result.failed} failed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
