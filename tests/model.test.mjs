import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompany, mergeFacts, UnsupportedFilerError } from '../docs/js/extract.js';
import { addScores, addSectorMultiples, analyse, analystView, discountedCashFlow, FORECAST_WEIGHT, residualIncome, impliedByPrice, valueRange } from '../docs/js/model.js';
import { COMPANIES, buildFacts } from './fixtures.mjs';

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

function run(key, overrides = {}) {
  const c = COMPANIES[key];
  const co = extractCompany(c.facts, { sic: c.sic, sicDescription: c.sicDescription });
  return analyse(co, { price: c.price, beta: c.beta, riskFree: 0.041, today: '2026-11-05', ...overrides });
}

test('DCF matches a calculation written out by hand', () => {
  const a = { growth: 0.025, margin: 0.25, rate: 0.1, terminal: 0.025, reinvestReturn: 0.2 };
  const fixed = { revenue: 1000, tax: 0.2, netClaims: 100, shares: 10, power: 1 };
  let revenue = 1000; let profit = 0; let pv = 0;
  for (let t = 1; t <= 10; t += 1) {
    revenue *= 1.025;
    profit = revenue * 0.25 * 0.8;
    pv += (profit * (1 - 0.025 / 0.2)) / 1.1 ** (t - 0.5);
  }
  const tv = (profit * 1.025 * (1 - 0.025 / 0.15)) / 0.075 / 1.1 ** 9.5;
  near(discountedCashFlow(a, fixed).perShare, (pv + tv - 100) / 10, 1e-9);
});

test('growth fades to the long-term rate by year 10', () => {
  const a = { growth: 0.2, margin: 0.2, rate: 0.1, terminal: 0.02, reinvestReturn: 0.2 };
  const high = discountedCashFlow(a, { revenue: 100, tax: 0.2, netClaims: 0, shares: 1, power: 1 });
  let compounded = 1;
  for (let t = 1; t <= 10; t += 1) compounded *= 1 + 0.02 + 0.18 * ((10 - t) / 9);
  near(high.averageGrowth, compounded ** 0.1 - 1, 1e-12);
});

test('faster growth needs more reinvestment, so a poor return adds little value', () => {
  const fixed = { revenue: 1000, tax: 0.2, netClaims: 0, shares: 1, power: 1 };
  const base = { margin: 0.2, rate: 0.1, terminal: 0.03 };
  const good = discountedCashFlow({ ...base, growth: 0.15, reinvestReturn: 0.3 }, fixed).perShare;
  const poor = discountedCashFlow({ ...base, growth: 0.15, reinvestReturn: 0.12 }, fixed).perShare;
  assert.ok(good > poor * 1.3);
});

test('residual income equals book value when returns equal the required return', () => {
  const a = { roe: 0.1, rate: 0.1, growth: 0.04, roeLong: 0.1 };
  near(residualIncome(a, { bvps: 50, terminal: 0.025 }).perShare, 50, 1e-9);
});

test('implied growth reproduces the share price', () => {
  const result = run('KO');
  const a = result.valuation.assumptions;
  const implied = impliedByPrice(result.valuation, a, 82.62);
  near(discountedCashFlow({ ...a, growth: implied.value }, result.valuation.fixed).perShare, 82.62, 1e-3);
  const bank = run('JPM');
  const b = bank.valuation.assumptions;
  const heldReturn = impliedByPrice(bank.valuation, b, 320.72);
  near(residualIncome({ ...b, roe: heldReturn.value, roeLong: heldReturn.value }, bank.valuation.fixed).perShare, 320.72, 1e-3);
  assert.ok(heldReturn.value > 0.1 && heldReturn.value < 0.25);
});

test('figures are extracted correctly across changed labels', () => {
  const co = extractCompany(COMPANIES.KO.facts, {});
  assert.equal(co.annual.length, 5);
  near(co.annual[0].revenue, 38655e6);
  near(co.annual.at(-1).revenue, 47941e6);
  assert.ok(co.ttm.isTrailing);
  near(co.ttm.ocf, 16342e6);
  near(co.ttm.capex, 2045e6);
  near(co.balance.debt, 47914e6);
  near(co.balance.longTermInvestments, 22900e6);
});

test('a company without trailing data falls back to the last full year', () => {
  const co = extractCompany(COMPANIES.F.facts, {});
  assert.equal(co.ttm.isTrailing, false);
  near(co.ttm.revenue, 187267e6);
});

test('each test company lands in the right type', () => {
  assert.equal(run('KO').type, 'steady');
  assert.equal(run('NVDA').type, 'growth');
  assert.equal(run('F').type, 'cyclical');
  assert.equal(run('JPM').type, 'financial');
  assert.equal(run('LOSS').type, 'lossMaking');
});

test('loss-making companies get no fair value', () => {
  const result = run('LOSS');
  assert.equal(result.fairValueAvailable, false);
  assert.ok(result.reason.length > 10);
});

test('default assumptions stay inside their limits', () => {
  for (const key of ['KO', 'NVDA', 'F']) {
    const { assumptions: a } = run(key).valuation;
    assert.ok(a.rate >= 0.08 && a.rate <= 0.12, key);
    assert.ok(a.growth >= 0 && a.growth <= 0.35, key);
    assert.ok(a.margin > 0 && a.margin <= 0.6, key);
    assert.equal(a.terminal, 0.03);
  }
  const { assumptions: b } = run('JPM').valuation;
  assert.ok(b.rate >= 0.08 && b.rate <= 0.13);
  assert.ok(b.roeLong >= b.rate && b.roeLong <= b.roe);
});

test('bear, base and bull are always in order and finite', () => {
  for (const key of ['KO', 'NVDA', 'F', 'JPM']) {
    const { range } = run(key);
    assert.ok(Number.isFinite(range.bear) && Number.isFinite(range.bull), key);
    assert.ok(range.bear < range.base && range.base < range.bull, key);
  }
});

test('every slider position gives a finite value', () => {
  for (const key of ['KO', 'NVDA', 'F', 'JPM']) {
    const { valuation } = run(key);
    for (const s of valuation.sliders) {
      for (const v of [s.min, s.max]) {
        const range = valueRange(valuation, { ...valuation.assumptions, [s.key]: v });
        assert.ok(Number.isFinite(range.base), `${key} ${s.key}=${v}`);
      }
    }
  }
});

test('confidence is higher for a steady company than a cyclical one', () => {
  assert.ok(run('KO').confidence.score > run('F').confidence.score);
  assert.equal(run('KO').confidence.level, 'High');
  assert.equal(run('JPM').confidence.level, 'Medium');
  assert.equal(run('F').confidence.level, 'Low');
});

test('missing market data still gives a result and lowers confidence', () => {
  const full = run('KO');
  const sparse = run('KO', { beta: undefined, riskFree: undefined, price: undefined });
  assert.equal(sparse.fairValueAvailable, true);
  assert.ok(sparse.confidence.score < full.confidence.score);
  assert.deepEqual(sparse.checks, []);
});

test('a share count that clashes with market data is replaced and flagged', () => {
  const result = run('KO', { finnhubShares: 8604e6 });
  assert.ok(result.warnings.some(w => w.includes('share count')));
  near(result.valuation.fixed.shares, 8604e6);
});

test('non-US accounting and foreign currency are refused clearly', () => {
  assert.throws(() => extractCompany({ entityName: 'X PLC', facts: { 'ifrs-full': {} } }, {}), UnsupportedFilerError);
  assert.throws(() => extractCompany({ entityName: 'X', facts: { 'us-gaap': { Assets: { units: { JPY: [] } } } } }, {}), UnsupportedFilerError);
  assert.throws(() => extractCompany({ entityName: 'Fund', facts: {} }, {}), UnsupportedFilerError);
});

test('the finance arm of a car maker reduces debt instead of being ignored', () => {
  const { valuation } = run('F');
  assert.ok(valuation.meta.captive);
  assert.ok(valuation.fixed.netClaims < 60000e6);
});

test('blank fields do not break a thinly reported company', () => {
  const facts = buildFacts({
    name: 'THIN CO', cik: 5, shares: 100,
    years: [{ end: '2024-12-31', revenue: 500, netIncome: 50, ocf: 70, capex: 10 }, { end: '2025-12-31', revenue: 530, netIncome: 55, ocf: 75, capex: 11 }],
    balance: { asOf: '2025-12-31', items: { Assets: 900, StockholdersEquity: 400, CashAndCashEquivalentsAtCarryingValue: 50 } },
  });
  const result = analyse(extractCompany(facts, { sic: 5000 }), { price: 10, today: '2026-11-05' });
  assert.equal(result.fairValueAvailable, true);
  assert.ok(Number.isFinite(result.range.base));
  assert.ok(result.confidence.reasons.some(r => r.includes('Debt')));
});

test('a full-year figure repeated in a later quarterly filing is kept', () => {
  const facts = structuredClone(COMPANIES.JPM.facts);
  const entries = facts.facts['us-gaap'].NetIncomeLoss.units.USD;
  const last = entries.find(e => e.end === '2025-12-31');
  entries.push({ ...last, form: '10-Q', filed: '2026-05-01' });
  const co = extractCompany(facts, { sic: 6021 });
  near(co.annual.at(-1).netIncome, 57050e6);
});

test('a share class mismatch uses the market value', () => {
  const c = COMPANIES.JPM;
  const co = extractCompany(c.facts, { sic: c.sic });
  co.shares = { val: 1.5e6, source: 'test' };
  const result = analyse(co, { price: 320, marketCap: 320 * 2656e6, finnhubShares: 2e6, beta: 1, riskFree: 0.041, today: '2026-11-05' });
  near(result.valuation.fixed.bvps, (372368e6 - 21040e6) / 2656e6, 1e-6);
  assert.ok(result.range.base < 1000);
});

test('a rebound after operating losses is not treated as lasting growth', () => {
  const facts = buildFacts({
    name: 'MEMORY CO', cik: 8, shares: 1000,
    years: [
      { end: '2022-12-31', revenue: 30000, opIncome: 9000, netIncome: 8000, ocf: 15000, capex: 12000 },
      { end: '2023-12-31', revenue: 15000, opIncome: -5500, netIncome: -6000, ocf: 1000, capex: 7000 },
      { end: '2024-12-31', revenue: 25000, opIncome: 1300, netIncome: 800, ocf: 8000, capex: 8000 },
      { end: '2025-12-31', revenue: 60000, opIncome: 22000, netIncome: 20000, ocf: 30000, capex: 13000 },
    ],
    balance: { asOf: '2025-12-31', items: { Assets: 90000, StockholdersEquity: 60000, CashAndCashEquivalentsAtCarryingValue: 10000, LongTermDebtNoncurrent: 12000 } },
  });
  const result = analyse(extractCompany(facts, { sic: 3674 }), { price: 100, beta: 1.2, riskFree: 0.045, today: '2026-11-05' });
  assert.equal(result.type, 'cyclical');
  assert.ok(result.valuation.assumptions.growth <= 0.05);
});

test('a value far from the price and a capex jump both lower confidence', () => {
  const c = COMPANIES.KO;
  const co = extractCompany(c.facts, { sic: c.sic });
  const market = { beta: c.beta, riskFree: 0.041, today: '2026-11-05' };
  const near_ = analyse(co, { ...market, price: 60 });
  const far = analyse(co, { ...market, price: 200 });
  assert.ok(far.confidence.reasons.some(r => r.includes('far from the share price')));
  assert.ok(far.confidence.score < near_.confidence.score);
  assert.notEqual(far.confidence.level, 'High');
  const spending = structuredClone(co);
  spending.ttm.capex = co.ttm.revenue * 0.3;
  assert.ok(analyse(spending, { ...market, price: 60 }).confidence.reasons.some(r => r.includes('Investment spending')));
});

test('a lagging market value does not override matching share counts', () => {
  const c = COMPANIES.KO;
  const co = extractCompany(c.facts, { sic: c.sic });
  const result = analyse(co, { price: 80, marketCap: 80 * 4302e6 * 1.25, finnhubShares: 4302e6, today: '2026-11-05' });
  near(result.valuation.fixed.shares, 4302e6);
  assert.ok(!result.warnings.some(w => w.includes('did not match')));
});

test('a new holding company keeps the history of the old one', () => {
  const oldFacts = COMPANIES.KO.facts;
  const newFacts = buildFacts({
    name: 'NEW HOLDINGS', cik: 9, shares: 4302,
    years: [],
    balance: { asOf: '2026-09-30', items: { Assets: 110000, StockholdersEquity: 36000, CashAndCashEquivalentsAtCarryingValue: 9000 } },
  });
  const bare = extractCompany(newFacts, { sic: 2080 });
  assert.equal(analyse(bare, { price: 80, today: '2026-11-05' }).type, 'tooNew');
  const co = extractCompany(mergeFacts(newFacts, oldFacts), { sic: 2080 });
  assert.equal(co.annual.length, 5);
  assert.equal(co.balance.asOf, '2026-09-30');
  assert.equal(co.name, 'NEW HOLDINGS');
});

test('a profitable company absorbing cash in investment still gets a value', () => {
  const facts = buildFacts({
    name: 'BIG INVESTOR', cik: 7, shares: 10000,
    years: [
      { end: '2022-12-31', revenue: 500000, opIncome: 12000, netIncome: -2000, ocf: 46000, capex: 60000, sbc: 19000 },
      { end: '2023-12-31', revenue: 570000, opIncome: 36000, netIncome: 30000, ocf: 84000, capex: 52000, sbc: 24000 },
      { end: '2024-12-31', revenue: 630000, opIncome: 68000, netIncome: 59000, ocf: 115000, capex: 83000, sbc: 22000 },
      { end: '2025-12-31', revenue: 710000, opIncome: 80000, netIncome: 77000, ocf: 139000, capex: 131000, sbc: 19000 },
    ],
    balance: { asOf: '2025-12-31', items: { Assets: 900000, StockholdersEquity: 400000, CashAndCashEquivalentsAtCarryingValue: 80000, LongTermDebtNoncurrent: 100000 } },
  });
  const result = analyse(extractCompany(facts, { sic: 5961 }), { price: 200, beta: 1.2, riskFree: 0.049, today: '2026-11-05' });
  assert.equal(result.type, 'steady');
  assert.equal(result.fairValueAvailable, true);
  assert.ok(result.valuation.assumptions.margin > 0.05);
});

test('heavy investment is not counted as a cost and a source of growth', () => {
  // Alphabet's real figures for 2025 and the 12 months to September 2026.
  const facts = buildFacts({
    name: 'ALPHABET INC', cik: 11, shares: 12294,
    years: [
      { end: '2022-12-31', revenue: 282836, opIncome: 74842, netIncome: 59972, pretax: 71328, tax: 11356, ocf: 91495, capex: 31485, sbc: 19362, equity: 256144 },
      { end: '2023-12-31', revenue: 307394, opIncome: 84293, netIncome: 73795, pretax: 85717, tax: 11922, ocf: 101746, capex: 32251, sbc: 22460, equity: 283379 },
      { end: '2024-12-31', revenue: 350018, opIncome: 112390, netIncome: 100118, pretax: 119815, tax: 19697, ocf: 125299, capex: 52535, sbc: 22785, equity: 325084 },
      { end: '2025-12-31', revenue: 402836, opIncome: 129039, netIncome: 132170, pretax: 158826, tax: 26656, ocf: 164700, capex: 91400, sbc: 25000, equity: 415300 },
    ],
    ttm: { end: '2026-09-30', values: { revenue: 471098, opIncome: 156976, netIncome: 235694, pretax: 287637, tax: 51900, ocf: 179600, capex: 159800, sbc: 30400 } },
    balance: { asOf: '2026-09-30', items: { Assets: 1000000, StockholdersEquity: 677500, CashAndCashEquivalentsAtCarryingValue: 56300, ShortTermInvestments: 208800, LongTermDebtNoncurrent: 127500 } },
  });
  const co = extractCompany(facts, { sic: 7370 });
  const result = analyse(co, { price: 284.31, beta: 1.25, riskFree: 0.049, peHistory: [25, 22, 27], sector: { pe: 30 }, today: '2026-11-05' });
  assert.ok(result.valuation.assumptions.margin > 0.3);
  assert.ok(result.range.model > 150, `forecast ${result.range.model}`);
  assert.ok(result.range.base > 200, `blended ${result.range.base}`);
  const earnings = result.checks.find(ch => ch.label === 'Price to earnings');
  assert.match(earnings.note, /gains on investments/);
});

test('fair value combines a forecast with trimmed market models', () => {
  const c = COMPANIES.KO;
  const co = extractCompany(c.facts, { sic: c.sic });
  const market = { price: c.price, beta: c.beta, riskFree: 0.049, today: '2026-11-05' };
  const alone = analyse(co, market);
  assert.deepEqual(alone.valuation.fixed.marketModels, []);
  near(alone.range.base, alone.range.model);
  const series = { pe: [['2025', 24], ['2024', 22], ['2023', 25]], evEbitda: [['2025', 20], ['2024', 19], ['2023', 21]], ps: [['2025', 6], ['2024', 5.5], ['2023', 6.5]] };
  const full = analyse(co, {
    ...market, series, stats: { enterpriseValue: 440000, evEbitdaTTM: 25, forwardPE: 27, forwardPEG: 3.5 }, sector: { pe: 21, evEbitda: 16 },
  });
  const models = full.valuation.fixed.marketModels;
  assert.equal(models.length, 5);
  const sorted = models.map(m => m.value).sort((x, y) => x - y).slice(1, -1);
  near(full.range.base, FORECAST_WEIGHT * full.range.model + (1 - FORECAST_WEIGHT) * (sorted[0] + sorted[1] + sorted[2]) / 3, 1e-9);
  assert.ok(full.range.bear < full.range.base && full.range.base < full.range.bull);
  const oneYear = analyse(co, { ...market, peHistory: [24] });
  assert.equal(oneYear.valuation.fixed.marketModels.length, 0);
});

test('analyst expectations come from forward P/E and PEG', () => {
  const c = COMPANIES.NVDA;
  const co = extractCompany(c.facts, { sic: c.sic });
  const market = { price: 180, beta: 1.5, riskFree: 0.049, today: '2026-11-05' };
  const without = analyse(co, market).valuation;
  const withView = analyse(co, { ...market, stats: { forwardPE: 15, forwardPEG: 0.3 } }).valuation;
  assert.match(withView.explain.growth, /analysts expect about 50%/);
  assert.ok(withView.assumptions.growth >= without.assumptions.growth);
  assert.ok(withView.assumptions.growth <= 0.35);
});

test('cyclical companies do not use peak forward earnings', () => {
  const c = COMPANIES.F;
  const co = extractCompany(c.facts, { sic: c.sic });
  const series = { pe: [['2025', 10], ['2024', 11], ['2023', 12]] };
  const market = { price: c.price, riskFree: 0.049, series, today: '2026-11-05' };
  const plain = analyse(co, market).valuation.fixed.marketModels[0].value;
  const peak = analyse(co, { ...market, stats: { forwardPE: 2 } }).valuation.fixed.marketModels[0].value;
  near(peak, plain);
});

test('scores rank companies from 1 to 5', () => {
  const entry = (sic, stats) => ({ co: { sic }, market: { stats } });
  const companies = {
    A: entry(2080, { revenueGrowth3Y: 20, operatingMarginTTM: 30, '26WeekPriceReturnDaily': 10, 'totalDebt/totalEquityQuarterly': 0.1 }),
    B: entry(2080, { revenueGrowth3Y: 5, operatingMarginTTM: 10, '26WeekPriceReturnDaily': -5, 'totalDebt/totalEquityQuarterly': 2 }),
    C: entry(6021, { revenueGrowth3Y: 10, operatingMarginTTM: 20, '26WeekPriceReturnDaily': 2, 'totalDebt/totalEquityQuarterly': 9 }),
  };
  addScores(companies, { A: 0.3, B: -0.3, C: 0 });
  assert.equal(companies.A.market.scores.growth, 5);
  assert.equal(companies.B.market.scores.growth, 1);
  assert.equal(companies.A.market.scores.value, 5);
  assert.equal(companies.C.market.scores.strength, null);
  assert.ok(companies.A.market.scores.overall > companies.B.market.scores.overall);
});

test('sector multiples ignore loss-makers and extreme readings', () => {
  const entry = (sic, value, profit) => ({
    co: { sic, annual: [], ttm: { opIncome: profit, revenue: 100, netIncome: profit }, shares: { val: 1 } },
    market: { price: value, marketCap: value },
  });
  const companies = {
    A: entry(2080, 200, 10), B: entry(2080, 240, 10), C: entry(2080, 300, 10), D: entry(2080, 160, 10), E: entry(2080, 180, 10),
    F: entry(2080, 900, -5), G: entry(2080, 5000, 10),
  };
  addSectorMultiples(companies);
  near(companies.A.market.sector.pe, 200 / (10 * 0.79), 1e-9);
  near(companies.F.market.sector.pe, companies.A.market.sector.pe);
});

test('companies filing as foreign issuers are refused clearly', () => {
  const facts = structuredClone(COMPANIES.KO.facts);
  facts.facts['us-gaap'].Assets.units.USD.push({ end: '2026-09-30', val: 1, form: '20-F', filed: '2026-10-30' });
  assert.throws(() => extractCompany(facts, {}), UnsupportedFilerError);
});

test('a young company with early losses can still be a fast grower', () => {
  const facts = buildFacts({
    name: 'RIDE CO', cik: 12, shares: 2000,
    years: [
      { end: '2022-12-31', revenue: 20000, opIncome: -1500, netIncome: -3000, ocf: 700, capex: 300 },
      { end: '2023-12-31', revenue: 28000, opIncome: 1000, netIncome: 1800, ocf: 3500, capex: 200 },
      { end: '2024-12-31', revenue: 36000, opIncome: 2800, netIncome: 3500, ocf: 7000, capex: 250 },
      { end: '2025-12-31', revenue: 44000, opIncome: 5000, netIncome: 5500, ocf: 9000, capex: 300 },
    ],
    balance: { asOf: '2025-12-31', items: { Assets: 60000, StockholdersEquity: 25000, CashAndCashEquivalentsAtCarryingValue: 7000, LongTermDebtNoncurrent: 9000 } },
  });
  assert.equal(analyse(extractCompany(facts, { sic: 7370 }), { price: 70, today: '2026-11-05' }).type, 'growth');
});

test('a steady company whose margins have fallen is not assumed to recover fully', () => {
  const c = COMPANIES.KO;
  const co = structuredClone(extractCompany(c.facts, { sic: c.sic }));
  const market = { price: c.price, today: '2026-11-05' };
  const normal = analyse(co, market).valuation.assumptions.margin;
  co.ttm.opIncome = co.ttm.revenue * normal * 0.4;
  const fallen = analyse(co, market).valuation;
  near(fallen.assumptions.margin, (normal * 0.4 + normal) / 2, 0.03);
  assert.match(fallen.explain.margin, /does not assume a full recovery/);
});

test('analyst forecasts set growth, margin, earnings and a price target model', () => {
  const c = COMPANIES.KO;
  const co = extractCompany(c.facts, { sic: c.sic });
  const last = co.annual.at(-1).revenue;
  const fmp = {
    estimates: [
      { end: '2026-12-31', revenue: last * 1.06, ebit: last * 1.06 * 0.32, eps: 3.2, analysts: 20 },
      { end: '2027-12-31', revenue: last * 1.06 * 1.06, ebit: last * 1.06 * 1.06 * 0.33, eps: 3.5, analysts: 18 },
    ],
    target: { consensus: 80, median: 79, high: 90, low: 65 },
  };
  const market = { price: c.price, beta: c.beta, riskFree: 0.049, today: '2026-11-05' };
  const view = analystView({ ...market, fmp }, co);
  near(view.growth, 0.06, 1e-9);
  near(view.margin, 0.33, 1e-9);
  assert.equal(view.eps, 3.2);
  const result = analyse(co, { ...market, fmp });
  assert.match(result.valuation.explain.growth, /analysts expect about 6% a year/);
  const target = result.valuation.fixed.marketModels.find(m => m.key === 'target');
  assert.equal(target.value, 80);
  const absurd = analyse(co, { ...market, fmp: { ...fmp, target: { consensus: c.price * 10, high: 1, low: 1 } } });
  assert.ok(!absurd.valuation.fixed.marketModels.some(m => m.key === 'target'));
});

test('without forecasts, analyst growth falls back to forward ratios', () => {
  const view = analystView({ price: 100, stats: { forwardPE: 20, forwardPEG: 2 } }, null);
  assert.equal(view.source, 'ratios');
  near(view.growth, 0.1, 1e-12);
});

test('health insurers use the forecast, not the bank method', () => {
  const c = COMPANIES.KO;
  assert.equal(analyse(extractCompany(c.facts, { sic: 6324 }), { price: c.price, today: '2026-11-05' }).valuation.kind, 'dcf');
});

