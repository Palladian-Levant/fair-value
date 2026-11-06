// Temporary: records which FMP features this key can use. Saves only status
// codes, field names and a few sample values, never the key or request URLs.
import { mkdir, writeFile } from 'node:fs/promises';

const key = process.env.FMP_API_KEY;
const symbols = ['AAPL', 'NVDA', 'DINO', 'PYPL'];
const paths = {
  profile: s => `profile?symbol=${s}`,
  estimates: s => `analyst-estimates?symbol=${s}&period=annual&limit=5`,
  targetConsensus: s => `price-target-consensus?symbol=${s}`,
  targetSummary: s => `price-target-summary?symbol=${s}`,
  grades: s => `grades-consensus?symbol=${s}`,
  ratiosTtm: s => `ratios-ttm?symbol=${s}`,
  keyMetricsTtm: s => `key-metrics-ttm?symbol=${s}`,
  dcf: s => `discounted-cash-flow?symbol=${s}`,
  scores: s => `financial-scores?symbol=${s}`,
  growth: s => `financial-growth?symbol=${s}&limit=2`,
  incomeStatement: s => `income-statement?symbol=${s}&limit=2`,
};
const shape = body => {
  const first = Array.isArray(body) ? body[0] : body;
  return first && typeof first === 'object' ? Object.keys(first).slice(0, 40) : typeof body;
};
const results = {};
for (const symbol of symbols) {
  for (const [name, build] of Object.entries(paths)) {
    if (symbol !== 'AAPL' && !['estimates', 'targetConsensus', 'grades', 'dcf'].includes(name)) continue;
    const response = await fetch(`https://financialmodelingprep.com/stable/${build(symbol)}&apikey=${encodeURIComponent(key)}`);
    const entry = { status: response.status };
    const text = await response.text();
    try {
      const body = JSON.parse(text);
      entry.count = Array.isArray(body) ? body.length : 1;
      entry.fields = shape(body);
      if (response.ok && ['estimates', 'targetConsensus', 'grades', 'dcf'].includes(name)) {
        entry.sample = JSON.stringify(Array.isArray(body) ? body.slice(0, 2) : body).slice(0, 700);
      }
      if (!response.ok || typeof body === 'string' || body?.['Error Message']) entry.message = String(body?.['Error Message'] ?? body?.message ?? body).slice(0, 200);
    } catch {
      entry.message = text.slice(0, 200).split(key).join('[key]');
    }
    results[`${symbol} ${name}`] = entry;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}
await mkdir('docs/data', { recursive: true });
await writeFile('docs/data/probe-fmp.json', JSON.stringify(results).split(key).join('[key]'));
