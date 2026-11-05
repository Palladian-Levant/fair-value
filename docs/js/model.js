// The valuation model: sorts a company into a type, picks sensible default
// assumptions, and turns those assumptions into a fair value range.
// All rates are fractions, so 0.05 means 5%.

import { sectorOf } from './sectors.js';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const percent = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const mean = list => list.reduce((sum, v) => sum + v, 0) / list.length;
const median = list => {
  const sorted = [...list].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stdev = list => {
  const average = mean(list);
  return Math.sqrt(mean(list.map(v => (v - average) ** 2)));
};
const years = (from, to) => (Date.parse(to) - Date.parse(from)) / (365.25 * 864e5);

const FALLBACK_RISK_FREE = 0.042;
const EQUITY_RISK_PREMIUM = 0.045;
const TERMINAL_GROWTH = 0.03;
const FORECAST_YEARS = 10;

const TYPE_LABELS = {
  steady: 'Steady company',
  growth: 'Fast grower',
  cyclical: 'Cyclical company',
  financial: 'Bank or insurer',
  lossMaking: 'Loss-making company',
  blank: 'Shell company',
  tooNew: 'New filer',
};

function cyclicalIndustry(sic) {
  if (!sic) return false;
  return (sic >= 1000 && sic <= 1499) // mining, oil and gas extraction
    || (sic >= 2900 && sic <= 2999) // oil refining
    || (sic >= 5171 && sic <= 5172) // fuel distribution
    || (sic >= 2800 && sic <= 2824) // basic chemicals
    || (sic >= 2860 && sic <= 2879) // industrial and farm chemicals
    || (sic >= 3310 && sic <= 3369) // steel and metals
    || (sic >= 3711 && sic <= 3716) // car makers and parts
    || sic === 4512 // airlines
    || (sic >= 4400 && sic <= 4499) // shipping
    || (sic >= 1520 && sic <= 1531); // housebuilders
}

function taxRate(rows) {
  const rates = rows.filter(r => r.pretax > 0 && r.tax != null).map(r => r.tax / r.pretax).filter(r => r > 0 && r < 0.6);
  return rates.length ? clamp(median(rates), 0.1, 0.3) : 0.21;
}

// Operating profit leaves out investment gains and already counts
// share-based pay as a cost, so it shows what the business itself earns.
function operatingProfit(row, tax) {
  if (row.opIncome != null) return row.opIncome;
  if (row.pretax != null) return row.pretax + (row.interest ?? 0);
  return row.netIncome != null ? row.netIncome / (1 - tax) : null;
}

function operatingMargin(row, tax) {
  const profit = operatingProfit(row, tax);
  return profit != null && row.revenue > 0 ? profit / row.revenue : null;
}

function cashAfterCosts(row) {
  return row.ocf != null && row.capex != null ? row.ocf - row.capex - (row.sbc ?? 0) : null;
}

function growthRates(co) {
  const { annual, ttm } = co;
  const rows = annual.filter(r => r.revenue > 0);
  const latest = ttm.revenue > 0 ? ttm : rows.at(-1);
  if (!latest || rows.length < 2) return { recent: null, long: null, short: null };
  const cagr = (fromRow) => {
    const span = years(fromRow.end, latest.end);
    return span > 0.5 ? (latest.revenue / fromRow.revenue) ** (1 / span) - 1 : null;
  };
  const yearly = rows.slice(1).map((r, i) => r.revenue / rows[i].revenue - 1);
  const lastSpan = years(rows.at(-1).end, latest.end);
  return {
    long: cagr(rows[Math.max(0, rows.length - 6)]),
    short: cagr(rows[Math.max(0, rows.length - 4)]),
    recent: lastSpan >= 0.4 ? (latest.revenue / rows.at(-1).revenue) ** (1 / lastSpan) - 1 : yearly.at(-1) ?? null,
    volatility: yearly.length > 1 ? stdev(yearly) : 0.05,
  };
}

function classify(co, tax) {
  const { sic, annual, ttm } = co;
  if (sic === 6770) return 'blank';
  // Health insurers (6324) earn operating margins like other healthcare companies.
  if (sic >= 6000 && sic <= 6411 && sic !== 6324) return 'financial';
  const rows = annual.slice(-5);
  if (!annual.length) return 'tooNew';
  const margins = rows.map(r => operatingMargin(r, tax)).filter(v => v != null);
  const latest = operatingMargin(ttm, tax);
  if (!margins.length || !(ttm.revenue > 1e7)) return 'lossMaking';
  const recentLosses = margins.length >= 2 && margins.at(-1) <= 0 && margins.at(-2) <= 0 && (latest ?? 0) <= 0;
  if (median(margins) <= 0 || recentLosses) return 'lossMaking';
  if (cyclicalIndustry(sic)) return 'cyclical';
  const g = growthRates(co);
  // Fast growth counts only if revenue has not fallen sharply on the way. A rebound
  // from a slump is a cycle, while a young company can have early losses behind it.
  const sales = rows.map(r => r.revenue).filter(v => v > 0);
  const slumped = sales.slice(1).some((value, i) => value < sales[i] * 0.9);
  const profitableNow = (latest ?? margins.at(-1)) > 0 && margins.at(-1) > 0;
  if (Math.max(g.short ?? 0, g.long ?? 0) >= 0.15 && profitableNow && !slumped) return 'growth';
  const swing = margins.length >= 3 ? stdev(margins) / Math.abs(mean(margins)) : 0;
  const lossYears = rows.filter(r => r.netIncome < 0).length;
  if (swing > 0.6 || lossYears >= 2 || Math.min(...margins) < 0) return 'cyclical';
  return 'steady';
}

function capitalCost(co, market, tax) {
  const riskFree = market.riskFree ?? FALLBACK_RISK_FREE;
  const betaRaw = market.beta;
  const betaKnown = typeof betaRaw === 'number' && betaRaw > 0;
  // Measured betas drift towards 1 over time, so extreme readings are pulled in.
  const beta = betaKnown ? clamp(0.67 * betaRaw + 0.33, 0.6, 1.8) : 1;
  const equityCost = riskFree + beta * EQUITY_RISK_PREMIUM;
  return { riskFree, riskFreeLive: market.riskFree != null, beta, betaKnown, equityCost, tax };
}

function defaultGrowth(g, type) {
  const limits = { steady: [0.01, 0.1], growth: [0.05, 0.25], cyclical: [0, 0.04] }[type];
  let raw = g.long != null && g.short != null ? (g.long + g.short) / 2 : g.short ?? g.long ?? 0.03;
  const slowing = g.recent != null && g.recent < raw - 0.03;
  if (slowing) raw = (raw + g.recent) / 2;
  const value = clamp(raw, limits[0], limits[1]);
  const history = g.long != null ? `Revenue grew about ${percent(g.long, 0)} a year over the last five years` : 'There is little revenue history';
  let reason = history;
  if (type === 'cyclical') reason += '. Cyclical companies get a low long-run rate, so one good stretch is not projected forward';
  else if (slowing) reason += `, and growth has slowed to ${percent(g.recent, 0)} recently`;
  if (value !== raw && type !== 'cyclical') reason += `. Capped at ${percent(limits[raw > limits[1] ? 1 : 0], 0)} for this type of company`;
  return { value, reason: `${reason}.` };
}

function defaultMargin(rows, ttmMargin, type) {
  const margins = rows.map(r => r.margin);
  const all = ttmMargin != null ? [...margins, ttmMargin] : margins;
  if (type === 'growth') {
    const recent = ttmMargin != null ? [ttmMargin, margins.at(-1)] : margins.slice(-2);
    return { value: clamp(mean(recent), 0.01, 0.6), reason: 'Uses recent margins, because older years understate a business that has changed quickly.' };
  }
  if (type === 'cyclical') {
    return { value: clamp(mean(all), 0.005, 0.6), reason: `Average across ${all.length} periods, covering good and bad years.` };
  }
  const middle = median(all);
  if (ttmMargin != null && ttmMargin < middle * 0.7) {
    return { value: clamp((middle + ttmMargin) / 2, 0.005, 0.6), reason: 'Recent margins have fallen well below normal, so this does not assume a full recovery.' };
  }
  return { value: clamp(middle, 0.005, 0.6), reason: `Middle value across ${all.length} periods, so one unusual year does not skew it.` };
}

// How much profit a company earns on the money tied up in the business.
function returnOnCapital(co, margin, tax) {
  const { balance, ttm } = co;
  const capital = (balance.equity ?? 0) + (balance.debt ?? 0) + (balance.noncontrolling ?? 0)
    - (balance.cash ?? 0) - (balance.shortTermInvestments ?? 0) - (balance.longTermInvestments ?? 0);
  const profit = ttm.revenue * margin * (1 - tax);
  return capital > 0 ? profit / capital : null;
}

function buildDcf(co, market, type, warnings) {
  const tax = taxRate(co.annual);
  const { balance, ttm, annual } = co;
  const receivableShare = balance.assets ? balance.financeReceivables / balance.assets : 0;
  const carMaker = co.sic >= 3711 && co.sic <= 3716;
  const captive = receivableShare > 0.25;
  const g = growthRates(co);

  const rows = annual
    .map(r => ({ ...r, margin: operatingMargin(r, tax) }))
    .filter(r => r.margin != null)
    .slice(-5);
  const ttmMargin = operatingMargin(ttm, tax);

  const cost = capitalCost(co, market, tax);
  const growth = defaultGrowth(g, type);
  const margin = defaultMargin(rows, ttmMargin, type);

  const debt = balance.debt ?? 0;
  const marketCap = market.price && co.shares ? market.price * co.shares.val : null;
  const debtWeight = marketCap ? debt / (debt + marketCap) : 0.15;
  const debtCost = (cost.riskFree + 0.015) * (1 - tax);
  const usesFinanceDebt = captive || carMaker;
  const rawRate = usesFinanceDebt ? cost.equityCost : (1 - debtWeight) * cost.equityCost + debtWeight * debtCost;
  const rate = clamp(rawRate, 0.08, 0.12);

  let revenueBase = ttm.revenue;
  if (type === 'cyclical') {
    const recent = annual.slice(-3).map(r => r.revenue).filter(v => v > 0);
    revenueBase = mean(ttm.isTrailing ? [...recent, ttm.revenue] : recent);
  }

  const measuredReturn = returnOnCapital(co, margin.value, tax);
  const newInvestmentReturn = clamp(measuredReturn ?? 0.2, rate + 0.02, 0.3);
  const receivablesOffset = usesFinanceDebt ? Math.min(balance.financeReceivables, debt) : 0;
  if (captive) warnings.push('This company runs a finance arm. Debt that funds its customer loans has been netted against those loans.');
  else if (carMaker) warnings.push('This company likely runs a finance arm, but its customer loans could not be found. Debt may be overstated, so treat the value with care.');

  const netClaims = debt - receivablesOffset + (balance.preferred ?? 0) + (balance.noncontrolling ?? 0)
    - (balance.cash ?? 0) - (balance.shortTermInvestments ?? 0) - (balance.longTermInvestments ?? 0);

  const spreadG = { steady: clamp(0.6 * (g.volatility ?? 0.05), 0.015, 0.03), growth: clamp(g.volatility ?? 0.06, 0.05, 0.08), cyclical: 0.015 }[type];
  const spreadM = { steady: 0.1, growth: 0.15, cyclical: 0.25 }[type];

  const rateParts = usesFinanceDebt
    ? `Treasury yield ${percent(cost.riskFree)} plus ${cost.beta.toFixed(2)} × ${percent(EQUITY_RISK_PREMIUM)} for share risk`
    : `Treasury yield ${percent(cost.riskFree)} plus ${cost.beta.toFixed(2)} × ${percent(EQUITY_RISK_PREMIUM)} for share risk, blended with the cost of its debt`;
  const rateReason = `${rateParts}${rawRate !== rate ? `, then held within 8–12%` : ''}.`;

  const returnReason = measuredReturn == null
    ? 'Its invested capital could not be measured, so a typical figure was used.'
    : `It earns about ${percent(measuredReturn, 0)} on the money in the business, held within sensible limits. Faster growth needs more reinvestment.`;

  const assumptions = { growth: growth.value, margin: margin.value, rate, terminal: TERMINAL_GROWTH, reinvestReturn: newInvestmentReturn };
  return {
    kind: 'dcf',
    assumptions,
    fixed: { revenue: revenueBase, tax, netClaims, shares: co.shares?.val ?? null, power: type === 'growth' ? 1.5 : 1, spreadG, spreadM },
    explain: {
      growth: growth.reason,
      margin: margin.reason,
      rate: rateReason,
      terminal: 'Roughly long-run economic growth, because no company can outgrow the economy forever.',
      reinvestReturn: returnReason,
    },
    sliders: [
      { key: 'growth', label: 'Growth next year', help: 'Fades down each year to the long-term rate', min: -0.1, max: Math.max(0.3, growth.value + 0.1), step: 0.005 },
      { key: 'margin', label: 'Operating margin', help: 'Operating profit from each $1 of sales', min: 0, max: Math.max(0.6, margin.value + 0.1), step: 0.005 },
      { key: 'rate', label: 'Discount rate', help: 'The yearly return you want for the risk', min: 0.06, max: 0.15, step: 0.0025 },
      { key: 'terminal', label: 'Long-term growth', help: 'Growth after year 10', min: 0, max: 0.04, step: 0.0025 },
      { key: 'reinvestReturn', label: 'Return on new investment', help: 'Profit earned on money put back into the business', min: 0.08, max: 0.4, step: 0.005 },
    ],
    meta: { rows, ttmMargin, tax, cost, g, captive, carMaker },
  };
}

function buildResidual(co, market, warnings) {
  const { annual, balance, ttm } = co;
  const tax = 0.21;
  const cost = capitalCost(co, market, tax);
  const preferred = balance.preferred ?? 0;
  const common = (balance.equity ?? 0) - preferred;
  const bvps = co.shares ? common / co.shares.val : null;
  const rows = annual.filter(r => r.equity > 0 && r.netIncome != null).map((r, i, all) => {
    const opening = i ? all[i - 1].equity : r.equity;
    return { ...r, roe: r.netIncome / ((r.equity + opening) / 2 - preferred) };
  }).slice(-5);
  const rawRoe = rows.length ? median(rows.map(r => r.roe)) : 0.1;
  const roe = clamp(rawRoe, 0.04, 0.25);
  const rate = clamp(cost.equityCost, 0.08, 0.13);
  const roeLong = Math.max(rate, rate + 0.4 * (roe - rate));

  const equityRows = annual.filter(r => r.equity > 0);
  let growth = 0.04;
  if (equityRows.length >= 3) {
    const span = years(equityRows[0].end, equityRows.at(-1).end);
    growth = clamp((equityRows.at(-1).equity / equityRows[0].equity) ** (1 / span) - 1, 0.02, 0.06);
  }

  warnings.push('Banks and insurers are valued on profits and book value, because normal cash flow figures do not work for them.');
  return {
    kind: 'residual',
    assumptions: { roe, rate, growth, roeLong },
    fixed: { bvps, spreadR: Math.max(0.015, 0.12 * roe), spreadLong: 0.01, terminal: TERMINAL_GROWTH },
    explain: {
      roe: `Middle value of the last ${rows.length} years' profit as a share of shareholders' money.`,
      rate: `Treasury yield ${percent(cost.riskFree)} plus ${cost.beta.toFixed(2)} × ${percent(EQUITY_RISK_PREMIUM)} for share risk.`,
      growth: 'Based on how fast shareholders\' equity has grown, kept within 2–6%.',
      roeLong: 'Competition usually erodes high returns, so this sits 40% of the way from the required return to today\'s level.',
    },
    sliders: [
      { key: 'roe', label: 'Return on equity', help: 'Profit on shareholders\' money today', min: 0, max: 0.35, step: 0.005 },
      { key: 'rate', label: 'Required return', help: 'The yearly return you want for the risk', min: 0.06, max: 0.16, step: 0.0025 },
      { key: 'growth', label: 'Book value growth', help: 'How fast the business grows for 10 years', min: 0, max: 0.1, step: 0.0025 },
      { key: 'roeLong', label: 'Long-term return on equity', help: 'Where returns settle after year 10', min: 0.04, max: 0.2, step: 0.0025 },
    ],
    meta: { rows, cost, ttm },
  };
}

// Discounted cash flow built from operating profit. Each year's cash is the
// profit after tax, less what must be reinvested to pay for that year's growth.
// This treats heavy investment as a choice that earns a return, and stops the
// model counting it as both a permanent cost and a source of growth.
// Cash arrives through each year, so flows are discounted from mid-year.
export function discountedCashFlow(a, fixed) {
  const rate = a.rate;
  const terminal = Math.min(a.terminal, rate - 0.03);
  const reinvestReturn = Math.max(a.reinvestReturn, 0.01);
  let revenue = fixed.revenue;
  let profit = 0;
  let presentValue = 0;
  let compounded = 1;
  for (let year = 1; year <= FORECAST_YEARS; year += 1) {
    const weight = ((FORECAST_YEARS - year) / (FORECAST_YEARS - 1)) ** fixed.power;
    const g = terminal + (a.growth - terminal) * weight;
    revenue *= 1 + g;
    compounded *= 1 + g;
    profit = revenue * a.margin * (1 - fixed.tax);
    presentValue += (profit * (1 - g / reinvestReturn)) / (1 + rate) ** (year - 0.5);
  }
  // Competition pulls returns on new investment down over the long run.
  const longReturn = Math.max(Math.min(reinvestReturn, Math.max(rate + 0.02, 0.15)), terminal + 0.01);
  const terminalCash = profit * (1 + terminal) * (1 - terminal / longReturn);
  const terminalValue = terminalCash / (rate - terminal) / (1 + rate) ** (FORECAST_YEARS - 0.5);
  const enterprise = presentValue + terminalValue;
  return {
    perShare: (enterprise - fixed.netClaims) / fixed.shares,
    terminalShare: terminalValue / enterprise,
    averageGrowth: compounded ** (1 / FORECAST_YEARS) - 1,
  };
}

// Excess return model: book value plus the present value of profits above
// what shareholders require.
export function residualIncome(a, fixed) {
  const rate = a.rate;
  const terminal = Math.min(fixed.terminal, rate - 0.03);
  let book = fixed.bvps;
  let value = book;
  for (let year = 1; year <= FORECAST_YEARS; year += 1) {
    const weight = (FORECAST_YEARS - year) / (FORECAST_YEARS - 1);
    const roe = a.roeLong + (a.roe - a.roeLong) * weight;
    value += ((roe - rate) * book) / (1 + rate) ** year;
    book *= 1 + a.growth;
  }
  const terminalValue = ((a.roeLong - rate) * book) / (rate - terminal) / (1 + rate) ** FORECAST_YEARS;
  const total = value + terminalValue;
  return { perShare: total, terminalShare: Math.abs(terminalValue) / Math.abs(total) };
}

// Fair value blends the cash flow model with what investors usually pay for
// these earnings, so a forecast from past results is not the only opinion.
const ANCHOR_WEIGHT = 0.25;

function blended(modelValue, anchors = [], factor = 1) {
  const anchorTotal = anchors.reduce((sum, anchor) => sum + ANCHOR_WEIGHT * anchor.value * factor, 0);
  return (1 - ANCHOR_WEIGHT * anchors.length) * modelValue + anchorTotal;
}

function earningsPerShare(valuation) {
  const { fixed, assumptions: a } = valuation;
  if (valuation.kind === 'dcf') return (fixed.revenue * a.margin * (1 - fixed.tax)) / fixed.shares;
  return a.roe * fixed.bvps;
}

function buildAnchors(valuation, market) {
  const eps = earningsPerShare(valuation);
  if (!(eps > 0)) return [];
  const anchors = [];
  const history = (market.peHistory ?? []).filter(v => v > 5 && v < 100);
  if (history.length >= 3) {
    const multiple = clamp(median(history), 8, 45);
    anchors.push({ key: 'history', label: 'Its usual price to earnings', detail: `${multiple.toFixed(1)} times normal earnings`, value: eps * multiple });
  }
  if (market.sectorPe > 0) {
    const multiple = clamp(market.sectorPe, 8, 45);
    anchors.push({ key: 'sector', label: 'Sector price to earnings', detail: `${multiple.toFixed(1)} times normal earnings`, value: eps * multiple });
  }
  return anchors;
}

// The typical price to earnings in each sector, using operating profit so that
// one-off gains do not distort it. Saved with each company by the nightly update.
export function addSectorMultiples(companies) {
  const bySector = {};
  const all = [];
  for (const [ticker, entry] of Object.entries(companies)) {
    const tax = taxRate(entry.co.annual);
    const value = entry.market.marketCap ?? entry.market.price * (entry.co.shares?.val ?? 0);
    const profit = entry.co.sic >= 6000 && entry.co.sic <= 6411 && entry.co.sic !== 6324
      ? entry.co.ttm.netIncome
      : (operatingProfit(entry.co.ttm, tax) ?? 0) * (1 - tax);
    if (!(value > 0) || !(profit > 0)) continue;
    const multiple = value / profit;
    if (multiple > 80) continue;
    (bySector[sectorOf(entry.co.sic, ticker)] ??= []).push(multiple);
    all.push(multiple);
  }
  for (const [ticker, entry] of Object.entries(companies)) {
    const peers = bySector[sectorOf(entry.co.sic, ticker)] ?? [];
    const group = peers.length >= 5 ? peers : all;
    entry.market.sectorPe = group.length ? median(group) : undefined;
  }
  return companies;
}

function runBase(valuation, a) {
  return valuation.kind === 'dcf' ? discountedCashFlow(a, valuation.fixed) : residualIncome(a, valuation.fixed);
}

export function valueRange(valuation, a) {
  const { fixed } = valuation;
  const base = runBase(valuation, a);
  if (valuation.kind === 'dcf') {
    const shift = (sign) => discountedCashFlow({
      ...a,
      growth: a.growth + sign * fixed.spreadG,
      margin: a.margin * (1 + sign * fixed.spreadM),
    }, fixed).perShare;
    return {
      bear: blended(shift(-1), fixed.anchors, 0.85),
      base: blended(base.perShare, fixed.anchors),
      bull: blended(shift(1), fixed.anchors, 1.15),
      model: base.perShare,
      terminalShare: base.terminalShare,
    };
  }
  const shift = sign => residualIncome({
    ...a,
    roe: a.roe + sign * fixed.spreadR,
    roeLong: a.roeLong + sign * fixed.spreadLong,
  }, fixed).perShare;
  return {
    bear: blended(shift(-1), fixed.anchors, 0.85),
    base: blended(base.perShare, fixed.anchors),
    bull: blended(shift(1), fixed.anchors, 1.15),
    model: base.perShare,
    terminalShare: base.terminalShare,
  };
}

// Works out what the current share price assumes, by searching for the
// growth rate (or return on equity) that makes the model equal the price.
export function impliedByPrice(valuation, a, price) {
  if (!price) return null;
  const key = valuation.kind === 'dcf' ? 'growth' : 'roe';
  let low = valuation.kind === 'dcf' ? -0.3 : 0;
  let high = valuation.kind === 'dcf' ? 1 : 0.6;
  // For banks the question is what return must be held for good, so both the
  // near-term and long-term returns move together.
  const applied = v => (valuation.kind === 'dcf' ? { ...a, growth: v } : { ...a, roe: v, roeLong: v });
  const valueAt = v => runBase(valuation, applied(v)).perShare;
  if (valueAt(low) > price) return { outOfRange: 'below', limit: low, key };
  if (valueAt(high) < price) return { outOfRange: 'above', limit: high, key };
  for (let i = 0; i < 60; i += 1) {
    const middle = (low + high) / 2;
    if (valueAt(middle) < price) low = middle; else high = middle;
  }
  const value = (low + high) / 2;
  return { key, value, averageGrowth: valuation.kind === 'dcf' ? runBase(valuation, applied(value)).averageGrowth : null };
}

function capexJumped(co) {
  const rows = co.annual.filter(r => r.capex != null && r.revenue > 0);
  if (rows.length < 3 || !co.ttm.revenue || co.ttm.capex == null) return false;
  const usual = median(rows.slice(0, -1).map(r => r.capex / r.revenue));
  return usual > 0 && co.ttm.capex / co.ttm.revenue > usual * 1.5;
}

function confidence(co, type, valuation, range, price) {
  let score = 100;
  const reasons = [];
  const dock = (points, reason) => { score -= points; reasons.push(reason); };
  if (type === 'cyclical') dock(30, 'Profits move with the economic cycle.');
  if (type === 'growth') dock(25, 'Fast growth is hard to forecast.');
  if (type === 'financial') dock(35, 'Banks and insurers are hard to judge from the outside.');
  if (co.annual.length < 5) dock(15, `Only ${co.annual.length} ${co.annual.length === 1 ? 'year' : 'years'} of accounts ${co.annual.length === 1 ? 'was' : 'were'} available.`);
  if (range.terminalShare > 0.8) dock(10, 'Most of the value comes from after year 10.');
  if (valuation.kind === 'dcf') {
    const margins = valuation.meta.rows.map(r => r.margin);
    if (margins.length >= 3 && stdev(margins) / Math.abs(mean(margins)) > 0.35) dock(15, 'Operating profit has swung a lot from year to year.');
    if (margins.some(m => m < 0)) dock(10, 'It has made an operating loss in a recent year.');
    if (co.ttm.netIncome < 0) dock(10, 'The company made a loss over the latest period.');
    if (valuation.meta.captive || valuation.meta.carMaker) dock(15, 'A finance arm makes the debt harder to judge.');
    if (co.balance.debt == null) dock(15, 'Debt could not be found in the filings.');
  }
  const farFromPrice = price && range.base > 0 && Math.abs(range.base / price - 1) > 0.5;
  const estimates = [range.model, ...(valuation.fixed.anchors ?? []).map(anchor => anchor.value)].filter(v => v > 0);
  if (estimates.length >= 2 && Math.max(...estimates) > 2.5 * Math.min(...estimates)) dock(10, 'The valuation methods disagree widely.');
  if (farFromPrice) dock(15, 'The value is far from the share price, so the model may be missing something.');
  if (valuation.kind === 'dcf' && capexJumped(co)) dock(10, 'Investment spending has jumped. The value assumes it earns a good return.');
  if (!valuation.meta.cost.betaKnown) dock(5, 'Share risk data was missing, so a market-average figure was used.');
  if (range.base > 0 && (range.bull - range.bear) / range.base > 1) dock(10, 'The range between low and high is very wide.');
  if (farFromPrice) score = Math.min(score, 69);
  const level = score >= 70 ? 'High' : score >= 45 ? 'Medium' : 'Low';
  if (!reasons.length) reasons.push('Consistent results and a good fit for this method.');
  return { level, score, reasons };
}

function senseChecks(co, market, valuation) {
  const checks = [];
  const { price, peHistory, week52High, week52Low } = market;
  const shares = market.sharesUsed ?? co.shares?.val;
  if (!price || !shares) return checks;
  const marketCap = price * shares;
  const tax = taxRate(co.annual);
  const coreProfit = operatingProfit(co.ttm, tax);
  const oneOffGains = co.ttm.pretax > 0 && coreProfit > 0 && co.ttm.pretax > coreProfit * 1.25;
  // Large investment gains flatter net profit, so use operating profit after tax.
  const earnings = oneOffGains ? coreProfit * (1 - tax) : co.ttm.netIncome;
  if (earnings > 0) {
    const pe = marketCap / earnings;
    const history = (peHistory ?? []).filter(v => v > 0 && v < 500);
    let note = oneOffGains ? 'Based on operating profit, because net profit includes large gains on investments.' : 'No past figures available to compare.';
    if (history.length >= 3) {
      const usual = median(history);
      const gap = pe / usual - 1;
      const word = Math.abs(gap) < 0.1 ? 'Close to' : gap > 0 ? 'Above' : 'Below';
      note = `${word} its usual ${usual.toFixed(1)}.${oneOffGains ? ' Uses operating profit, because net profit includes large gains on investments.' : ''}`;
    }
    checks.push({ label: 'Price to earnings', value: pe.toFixed(1), note });
  } else if (earnings != null) {
    checks.push({ label: 'Price to earnings', value: 'n/a', note: 'The company made a loss over this period.' });
  }
  if (valuation?.kind === 'dcf') {
    const fcf = cashAfterCosts(co.ttm);
    if (fcf != null) checks.push({ label: 'Free cash flow yield', value: percent(fcf / marketCap), note: 'Latest yearly cash as a share of the company\'s value.' });
  } else if (valuation?.kind === 'residual' && valuation.fixed.bvps > 0) {
    checks.push({ label: 'Price to book', value: (price / valuation.fixed.bvps).toFixed(2), note: 'Share price compared with book value per share.' });
  }
  const dividends = co.annual.at(-1)?.dividends;
  if (dividends > 0) checks.push({ label: 'Dividend yield', value: percent(dividends / marketCap), note: 'Last full year of dividends.' });
  if (week52High > week52Low) {
    const position = clamp((price - week52Low) / (week52High - week52Low), 0, 1);
    checks.push({ label: 'Within 52-week range', value: `${Math.round(position * 100)}%`, note: `Low $${week52Low.toFixed(2)}, high $${week52High.toFixed(2)}.` });
  }
  return checks;
}

function companyWarnings(co, market, warnings, type) {
  if (co.sic === 6798) warnings.push('Property trusts report large property purchases differently, so this model fits them poorly.');
  const lastRow = co.annual.at(-1);
  if (lastRow?.sbc && lastRow.revenue && lastRow.sbc / lastRow.revenue > 0.1) {
    warnings.push('Share-based pay is large here. It is treated as a real cost, which lowers the value.');
  }
  if (co.balance.asOf && market.today && years(co.balance.asOf, market.today) > 0.6) {
    warnings.push(`The latest balance sheet is from ${co.balance.asOf}, so the figures may be out of date.`);
  }
  if (market.shareMismatch) warnings.push('The share count from the SEC did not match market data, so the market figure was used.');
  if (type === 'growth') warnings.push('The result leans heavily on growth that has not happened yet.');
}

const within = (a, b, tolerance) => a > 0 && b > 0 && Math.abs(a / b - 1) <= tolerance;

// Filings can show one share class only, and market value can lag the price,
// so market value only settles a real disagreement.
function chooseShares(sec, market, impliedByValue) {
  if (!sec) return market || impliedByValue || null;
  if (market && !within(market, sec, 0.1)) {
    if (!impliedByValue) return market;
    const closest = Math.abs(market / impliedByValue - 1) < Math.abs(sec / impliedByValue - 1) ? market : sec;
    return within(closest, impliedByValue, 0.35) ? closest : impliedByValue;
  }
  if (!market && impliedByValue && !within(impliedByValue, sec, 0.35)) return impliedByValue;
  return sec;
}

// Builds everything the page needs for one company.
export function analyse(co, marketInput = {}) {
  const market = { ...marketInput };
  const secShares = co.shares?.val;
  const shares = chooseShares(secShares, market.finnhubShares, market.marketCap > 0 && market.price > 0 ? market.marketCap / market.price : null);
  if (shares && shares !== secShares) {
    market.shareMismatch = Boolean(secShares);
    co = { ...co, shares: { val: shares, source: 'market data' } };
  }
  market.sharesUsed = co.shares?.val;

  const tax = taxRate(co.annual);
  const type = classify(co, tax);
  const warnings = [];
  const label = TYPE_LABELS[type];

  if (type === 'lossMaking' || type === 'blank' || type === 'tooNew' || !co.shares) {
    const reasons = {
      blank: 'It is a shell company with no real business to value yet.',
      tooNew: 'Its filings do not include a full year of accounts yet.',
      lossMaking: 'It has not produced steady cash or profit, so any fair value would be a guess about the far future.',
    };
    const reason = co.shares ? reasons[type] : 'Its share count could not be found in the filings, so a per-share value is not possible.';
    return { type, label, co, market, fairValueAvailable: false, reason, checks: senseChecks(co, market, null), warnings };
  }

  const valuation = type === 'financial' ? buildResidual(co, market, warnings) : buildDcf(co, market, type, warnings);
  if (valuation.kind === 'residual' && !(valuation.fixed.bvps > 0)) {
    return { type, label, co, market, fairValueAvailable: false, reason: 'Its book value is zero or negative, so this method cannot be used.', checks: senseChecks(co, market, null), warnings };
  }
  companyWarnings(co, market, warnings, type);
  valuation.fixed.anchors = buildAnchors(valuation, market);
  const range = valueRange(valuation, valuation.assumptions);
  return {
    type,
    label,
    co,
    market,
    valuation,
    fairValueAvailable: true,
    range,
    confidence: confidence(co, type, valuation, range, market.price),
    checks: senseChecks(co, market, valuation),
    warnings,
  };
}
