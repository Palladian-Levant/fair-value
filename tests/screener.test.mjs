import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScreener, candidateList, isSafeToPublish, pacedClient, parseTreasury } from '../scripts/build-screener.mjs';
import { sectorOf, SECTORS } from '../docs/js/sectors.js';
import { daysOld, filterRows, sortRows } from '../docs/js/screener.js';
import { COMPANIES, TICKERS } from './fixtures.mjs';

const byCik = Object.fromEntries(Object.values(COMPANIES).map(c => [String(c.cik).padStart(10, '0'), c]));
const bySymbol = Object.fromEntries(Object.values(COMPANIES).map(c => [c.ticker, c]));
const treasury = '<d:BC_10YEAR m:type="Edm.Double">4.10</d:BC_10YEAR>';

function sources({ failCik, failAll } = {}) {
  const sec = async url => {
    const cik = url.match(/CIK(\d+)/)?.[1];
    if (failAll || cik === failCik) throw Object.assign(new Error('status 503'), { status: 503 });
    if (!byCik[cik]) throw Object.assign(new Error('status 404'), { status: 404 });
    if (url.includes('companyfacts')) return byCik[cik].facts;
    return { sic: String(byCik[cik].sic), sicDescription: byCik[cik].sicDescription };
  };
  const finnhub = async url => {
    const symbol = decodeURIComponent(url.match(/symbol=([^&]+)/)[1]);
    const c = bySymbol[symbol];
    if (url.includes('/quote')) return { c: c?.price ?? 0 };
    if (url.includes('/metric')) return { metric: { beta: c?.beta, '52WeekHigh': 95 }, series: { annual: { pe: [{ v: 24 }] } } };
    return { name: c?.displayName };
  };
  return { sec, finnhub, plain: async () => treasury };
}

test('sectors match well-known companies', () => {
  const cases = [
    [2080, 'Consumer staples'], [3674, 'Technology'], [7372, 'Technology'], [3711, 'Consumer discretionary'],
    [6021, 'Financials'], [6798, 'Real estate'], [2911, 'Energy'], [1311, 'Energy'], [2834, 'Healthcare'],
    [4911, 'Utilities'], [4813, 'Communication'], [3721, 'Industrials'], [1040, 'Materials'], [5331, 'Consumer discretionary'], [5411, 'Consumer staples'],
  ];
  for (const [sic, sector] of cases) assert.equal(sectorOf(sic), sector, String(sic));
  assert.equal(sectorOf(null), 'Other');
  assert.ok(SECTORS.at(-1) === 'Other');
});

test('share classes of one company appear once', () => {
  const list = candidateList({ 0: { cik_str: 1, ticker: 'GOOGL', title: 'A' }, 1: { cik_str: 1, ticker: 'GOOG', title: 'A' }, 2: { cik_str: 2, ticker: 'B', title: 'B' } });
  assert.deepEqual(list.map(c => c.ticker), ['GOOGL', 'B']);
  assert.equal(list[1].cik, '0000000002');
});

test('nightly results use the same model and leave out companies it cannot value', async () => {
  const result = await buildScreener({ tickers: TICKERS, ...sources(), now: new Date('2026-11-05T23:00:00Z') });
  const tickers = result.rows.map(r => r.ticker).sort();
  assert.deepEqual(tickers, ['F', 'JPM', 'KO', 'NVDA']);
  const ko = result.rows.find(r => r.ticker === 'KO');
  assert.equal(ko.sector, 'Consumer staples');
  assert.equal(ko.confidence, 'High');
  assert.equal(ko.name, 'Coca-Cola Co');
  assert.ok(Math.abs(ko.gap - (ko.fair / ko.price - 1)) < 1e-3);
  assert.ok(ko.low < ko.fair && ko.fair < ko.high);
  assert.equal(result.notValued.Healthcare, 1);
  assert.equal(result.notValued.Other, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(Object.keys(result.companies).sort(), ['F', 'JPM', 'KO', 'LOSS', 'NVDA']);
  assert.equal(result.companies.KO.market.price, 82.62);
  assert.equal(result.rows[0].ticker, 'NVDA');
});

test('a failed company does not stop the run', async () => {
  const result = await buildScreener({ tickers: TICKERS, ...sources({ failCik: '0000021344' }) });
  assert.ok(!result.rows.some(r => r.ticker === 'KO'));
  assert.ok(result.rows.some(r => r.ticker === 'JPM'));
  assert.equal(result.failed, 1);
});

test('a missing Treasury yield still gives results', async () => {
  const s = sources();
  const result = await buildScreener({ tickers: TICKERS, ...s, plain: async () => { throw new Error('down'); } });
  assert.equal(result.rows.length, 4);
});

test('the list keeps only the largest companies', async () => {
  const result = await buildScreener({ tickers: TICKERS, ...sources(), keep: 2 });
  assert.deepEqual(result.rows.map(r => r.ticker), ['NVDA', 'JPM']);
});

test('suspicious results are flagged, not hidden', async () => {
  const s = sources();
  const cheap = async url => (url.includes('/quote') && url.includes('symbol=KO') ? { c: 10 } : s.finnhub(url));
  const result = await buildScreener({ tickers: TICKERS, ...s, finnhub: cheap });
  assert.ok(result.rows.find(r => r.ticker === 'KO').flags.includes('Unusually large gap'));
  assert.ok(result.rows.find(r => r.ticker === 'F').flags.includes('Recent loss'));
});

test('a bad run never replaces good results', () => {
  const row = {};
  const rows = n => Array(n).fill(row);
  assert.equal(isSafeToPublish({ attempted: 600, failed: 10, rows: rows(500) }, 500).ok, true);
  assert.equal(isSafeToPublish({ attempted: 600, failed: 10, rows: rows(20) }).ok, false);
  assert.equal(isSafeToPublish({ attempted: 600, failed: 300, rows: rows(280) }).ok, false);
  assert.equal(isSafeToPublish({ attempted: 600, failed: 10, rows: rows(300) }, 500).ok, false);
  assert.equal(isSafeToPublish({ attempted: 40, failed: 2, rows: rows(30) }, 500, true).ok, true);
  assert.equal(isSafeToPublish({ attempted: 40, failed: 40, rows: [] }, 500, true).ok, false);
});

test('busy responses are retried with waits, and errors never contain the key', async () => {
  let calls = 0;
  const pauses = [];
  const request = pacedClient({
    gapMs: 0,
    headers: { 'X-Finnhub-Token': 'secret-key' },
    sleep: async ms => { pauses.push(ms); },
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? new Response('busy', { status: 429 }) : new Response('{"c":5}');
    },
  });
  assert.deepEqual(await request('https://x.test'), { c: 5 });
  assert.equal(calls, 3);
  assert.ok(pauses.length >= 2);

  const denied = pacedClient({ gapMs: 0, headers: {}, fetchImpl: async () => new Response('token=secret-key', { status: 403 }) });
  await assert.rejects(denied('https://x.test'), error => error.status === 403 && !error.message.includes('secret-key'));
});

test('Treasury yields are read from the latest entry', () => {
  const rate = parseTreasury('<d:BC_10YEAR m:type="Edm.Double">4.05</d:BC_10YEAR><d:BC_10YEAR m:type="Edm.Double">4.10</d:BC_10YEAR>');
  assert.ok(Math.abs(rate - 0.041) < 1e-12);
  assert.equal(parseTreasury('<feed></feed>'), null);
});

test('filters and sorting on the screener', () => {
  const rows = [
    { ticker: 'A', sector: 'Energy', confidence: 'High', score: 80, gap: 0.2, cap: 5e9, price: 1, fair: 1 },
    { ticker: 'B', sector: 'Energy', confidence: 'Medium', score: 60, gap: 0.6, cap: 50e9, price: 2, fair: 3 },
    { ticker: 'C', sector: 'Energy', confidence: 'Low', score: 20, gap: 2, cap: 60e9, price: 1, fair: 3 },
    { ticker: 'D', sector: 'Technology', confidence: 'High', score: 90, gap: -0.2, cap: 900e9, price: 9, fair: 7 },
  ];
  assert.deepEqual(filterRows(rows, { sector: 'Energy' }).map(r => r.ticker), ['A', 'B']);
  assert.deepEqual(filterRows(rows, { sector: 'Energy', minConfidence: 'Low' }).map(r => r.ticker), ['A', 'B', 'C']);
  assert.deepEqual(filterRows(rows, { minConfidence: 'High', minCap: 10e9 }).map(r => r.ticker), ['D']);
  assert.deepEqual(sortRows(rows).map(r => r.ticker), ['C', 'B', 'A', 'D']);
  assert.deepEqual(sortRows(rows, 'confidence').map(r => r.ticker), ['D', 'A', 'B', 'C']);
  assert.deepEqual(sortRows(rows, 'gap', 'asc').map(r => r.ticker), ['D', 'A', 'B', 'C']);
  assert.equal(daysOld('2026-11-01T00:00:00Z', Date.parse('2026-11-05T12:00:00Z')), 4);
});
