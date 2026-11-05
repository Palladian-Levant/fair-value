import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCompany, UnsupportedFilerError } from '../docs/js/extract.js';
import { analyse, discountedCashFlow, residualIncome, impliedByPrice, valueRange } from '../docs/js/model.js';
import { COMPANIES, buildFacts } from './fixtures.mjs';

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

function run(key, overrides = {}) {
  const c = COMPANIES[key];
  const co = extractCompany(c.facts, { sic: c.sic, sicDescription: c.sicDescription });
  return analyse(co, { price: c.price, beta: c.beta, riskFree: 0.041, today: '2026-11-05', ...overrides });
}

test('DCF matches a calculation written out by hand', () => {
  const a = { growth: 0.025, margin: 0.2, rate: 0.1, terminal: 0.025 };
  const fixed = { revenue: 1000, netClaims: 100, shares: 10, power: 1 };
  let cash = 200; let pv = 0;
  for (let t = 1; t <= 10; t += 1) { cash *= 1.025; pv += cash / 1.1 ** (t - 0.5); }
  const tv = (cash * 1.025) / 0.075 / 1.1 ** 9.5;
  near(discountedCashFlow(a, fixed).perShare, (pv + tv - 100) / 10, 1e-9);
});

test('growth fades to the long-term rate by year 10', () => {
  const a = { growth: 0.2, margin: 0.2, rate: 0.1, terminal: 0.02 };
  const high = discountedCashFlow(a, { revenue: 100, netClaims: 0, shares: 1, power: 1 });
  let compounded = 1;
  for (let t = 1; t <= 10; t += 1) compounded *= 1 + 0.02 + 0.18 * ((10 - t) / 9);
  near(high.averageGrowth, compounded ** 0.1 - 1, 1e-12);
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
    assert.ok(a.growth >= 0 && a.growth <= 0.25, key);
    assert.ok(a.margin > 0 && a.margin <= 0.6, key);
    assert.equal(a.terminal, 0.025);
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

test('printed defaults for a review', () => {
  for (const key of ['KO', 'NVDA', 'F', 'JPM']) {
    const r = run(key);
    const a = r.valuation.assumptions;
    console.log(key, r.label, Object.fromEntries(Object.entries(a).map(([k, v]) => [k, +(v * 100).toFixed(1)])),
      'bear/base/bull', r.range.bear.toFixed(0), r.range.base.toFixed(0), r.range.bull.toFixed(0), 'price', COMPANIES[key].price,
      r.confidence.level, r.confidence.score, 'tv', r.range.terminalShare.toFixed(2),
      'implied', JSON.stringify(impliedByPrice(r.valuation, a, COMPANIES[key].price)));
  }
});
