// Temporary: records which Finnhub features this key can use. Saves only
// status codes and field names, never the key.
import { mkdir, writeFile } from 'node:fs/promises';

const key = process.env.FINNHUB_API_KEY;
const paths = {
  quote: '/quote?symbol=AAPL', profile: '/stock/profile2?symbol=AAPL', metric: '/stock/metric?symbol=AAPL&metric=all',
  recommendation: '/stock/recommendation?symbol=AAPL', earnings: '/stock/earnings?symbol=AAPL', peers: '/stock/peers?symbol=AAPL',
  insiderTransactions: '/stock/insider-transactions?symbol=AAPL', insiderSentiment: '/stock/insider-sentiment?symbol=AAPL&from=2026-01-01&to=2026-11-01',
  priceTarget: '/stock/price-target?symbol=AAPL', epsEstimate: '/stock/eps-estimate?symbol=AAPL&freq=annual', revenueEstimate: '/stock/revenue-estimate?symbol=AAPL&freq=annual',
  ebitdaEstimate: '/stock/ebitda-estimate?symbol=AAPL&freq=annual', upgrades: '/stock/upgrade-downgrade?symbol=AAPL', dividends: '/stock/dividend?symbol=AAPL&from=2025-01-01&to=2026-11-01',
  reported: '/stock/financials-reported?symbol=AAPL&freq=annual', companyNews: '/company-news?symbol=AAPL&from=2026-10-25&to=2026-11-05', newsSentiment: '/news-sentiment?symbol=AAPL',
  earningsCalendar: '/calendar/earnings?symbol=AAPL&from=2026-11-01&to=2027-03-01', candle: '/stock/candle?symbol=AAPL&resolution=W&from=1700000000&to=1793000000',
  priceMetric: '/stock/price-metric?symbol=AAPL', ownership: '/stock/ownership?symbol=AAPL&limit=3', fundOwnership: '/stock/fund-ownership?symbol=AAPL&limit=3',
  executives: '/stock/executive?symbol=AAPL', revenueBreakdown: '/stock/revenue-breakdown?symbol=AAPL', esg: '/stock/esg?symbol=AAPL',
};
const outline = value => {
  if (Array.isArray(value)) return { array: value.length, first: value[0] && typeof value[0] === 'object' ? Object.keys(value[0]) : value[0] };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 12).map(([k, v]) => [k, Array.isArray(v) ? `array ${v.length}` : typeof v]));
  return typeof value;
};
const results = {};
for (const [name, path] of Object.entries(paths)) {
  const response = await fetch(`https://finnhub.io/api/v1${path}`, { headers: { 'X-Finnhub-Token': key } });
  const entry = { status: response.status };
  if (response.ok) {
    const body = await response.json();
    entry.shape = outline(body);
    if (name === 'metric') entry.metricKeys = Object.keys(body.metric ?? {}), entry.seriesAnnual = Object.keys(body.series?.annual ?? {});
    if (name === 'recommendation' || name === 'earnings' || name === 'peers') entry.sample = Array.isArray(body) ? body.slice(0, 2) : null;
  }
  results[name] = entry;
  await new Promise(resolve => setTimeout(resolve, 1100));
}
await mkdir('docs/data', { recursive: true });
await writeFile('docs/data/probe.json', JSON.stringify(results));
