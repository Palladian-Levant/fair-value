// The valuation model: sorts a company into a type, picks sensible default
// assumptions, and turns those assumptions into a fair value range.
// All rates are fractions, so 0.05 means 5%.

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
const TERMINAL_GROWTH = 0.025;
const FORECAST_YEARS = 10;

const TYPE_LABELS = {
  steady: 'Steady company',
  growth: 'Fast grower',
  cyclical: 'Cyclical company',
  financial: 'Bank or insurer',
  lossMaking: 'Loss-making company',
  blank: 'Shell company',
};

function cyclicalIndustry(sic) {
  if (!sic) return false;
  return (sic >= 1000 && sic <= 1499) // mining, oil and gas extraction
    || sic === 2911 // oil refining
    || (sic >= 2800 && sic <= 2824) // basic chemicals
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

function freeCashFlow(row, tax, addBackInterest) {
  if (row.ocf == null || row.capex == null) return null;
  const interest = addBackInterest ? (row.interest ?? 0) * (1 - tax) : 0;
  return row.ocf - row.capex - (row.sbc ?? 0) + interest;
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
  if (sic >= 6000 && sic <= 6411) return 'financial';
  const rows = annual.slice(-5);
  const hasCash = rows.filter(r => freeCashFlow(r, tax, false) != null);
  const margins = hasCash.filter(r => r.revenue > 0).map(r => freeCashFlow(r, tax, false) / r.revenue);
  const ttmFcf = freeCashFlow(ttm, tax, false);
  const lastFcf = hasCash.length ? freeCashFlow(hasCash.at(-1), tax, false) : null;
  if (!margins.length || !(ttm.revenue > 1e7)) return 'lossMaking';
  if (median(margins) <= 0 || (ttmFcf <= 0 && lastFcf <= 0 && ttm.netIncome <= 0)) return 'lossMaking';
  if (cyclicalIndustry(sic)) return 'cyclical';
  const g = growthRates(co);
  if (Math.max(g.short ?? 0, g.long ?? 0) >= 0.15) return 'growth';
  const swing = margins.length >= 3 ? stdev(margins) / Math.abs(mean(margins)) : 0;
  const lossYears = rows.filter(r => r.netIncome < 0).length;
  if (swing > 0.6 || lossYears >= 2) return 'cyclical';
  return 'steady';
}

function capitalCost(co, market, tax) {
  const riskFree = market.riskFree ?? FALLBACK_RISK_FREE;
  const betaRaw = market.beta;
  const betaKnown = typeof betaRaw === 'number' && betaRaw > 0;
  const beta = betaKnown ? clamp(betaRaw, 0.6, 1.8) : 1;
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
  const swing = all.length >= 3 ? stdev(all) / Math.abs(mean(all)) : 0;
  const profitMargins = rows.filter(r => r.netIncome != null).slice(-3).map(r => r.netIncome / r.revenue);
  if (swing > 0.25 && profitMargins.length) {
    // One-off items can distort cash for a year or two, while profit over several years is steadier.
    return {
      value: clamp((middle + median(profitMargins)) / 2, 0.005, 0.6),
      reason: 'Cash flow has jumped around, so this blends the middle cash margin with the recent profit margin.',
    };
  }
  return { value: clamp(middle, 0.005, 0.6), reason: `Middle value across ${all.length} periods, so one unusual year does not skew it.` };
}

function buildDcf(co, market, type, warnings) {
  const tax = taxRate(co.annual);
  const { balance, ttm, annual } = co;
  const receivableShare = balance.assets ? balance.financeReceivables / balance.assets : 0;
  const carMaker = co.sic >= 3711 && co.sic <= 3716;
  const captive = receivableShare > 0.25;
  const addBack = !captive && !carMaker;
  const g = growthRates(co);

  const rows = annual
    .map(r => ({ ...r, fcf: freeCashFlow(r, tax, addBack) }))
    .filter(r => r.fcf != null && r.revenue > 0)
    .map(r => ({ ...r, margin: r.fcf / r.revenue }))
    .slice(-5);
  const ttmFcf = freeCashFlow(ttm, tax, addBack);
  const ttmMargin = ttm.revenue > 0 && ttmFcf != null ? ttmFcf / ttm.revenue : null;

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

  const assumptions = { growth: growth.value, margin: margin.value, rate, terminal: TERMINAL_GROWTH };
  return {
    kind: 'dcf',
    assumptions,
    fixed: { revenue: revenueBase, netClaims, shares: co.shares?.val ?? null, power: type === 'growth' ? 1.5 : 1, spreadG, spreadM },
    explain: {
      growth: growth.reason,
      margin: margin.reason,
      rate: rateReason,
      terminal: 'Roughly long-run economic growth, because no company can outgrow the economy forever.',
    },
    sliders: [
      { key: 'growth', label: 'Growth next year', help: 'Fades down each year to the long-term rate', min: -0.1, max: Math.max(0.3, growth.value + 0.1), step: 0.005 },
      { key: 'margin', label: 'Free cash flow margin', help: 'Cash left from each $1 of sales', min: 0, max: Math.max(0.6, margin.value + 0.1), step: 0.005 },
      { key: 'rate', label: 'Discount rate', help: 'The yearly return you want for the risk', min: 0.06, max: 0.15, step: 0.0025 },
      { key: 'terminal', label: 'Long-term growth', help: 'Growth after year 10', min: 0, max: 0.04, step: 0.0025 },
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

// Discounted cash flow. Cash arrives through each year, so flows are
// discounted from the middle of the year.
export function discountedCashFlow(a, fixed) {
  const rate = a.rate;
  const terminal = Math.min(a.terminal, rate - 0.03);
  let cash = fixed.revenue * a.margin;
  let presentValue = 0;
  let compounded = 1;
  for (let year = 1; year <= FORECAST_YEARS; year += 1) {
    const weight = ((FORECAST_YEARS - year) / (FORECAST_YEARS - 1)) ** fixed.power;
    const g = terminal + (a.growth - terminal) * weight;
    cash *= 1 + g;
    compounded *= 1 + g;
    presentValue += cash / (1 + rate) ** (year - 0.5);
  }
  const terminalValue = (cash * (1 + terminal)) / (rate - terminal) / (1 + rate) ** (FORECAST_YEARS - 0.5);
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
    return { bear: shift(-1), base: base.perShare, bull: shift(1), terminalShare: base.terminalShare };
  }
  const shift = sign => residualIncome({
    ...a,
    roe: a.roe + sign * fixed.spreadR,
    roeLong: a.roeLong + sign * fixed.spreadLong,
  }, fixed).perShare;
  return { bear: shift(-1), base: base.perShare, bull: shift(1), terminalShare: base.terminalShare };
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

function confidence(co, type, valuation, range) {
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
    if (margins.length >= 3 && stdev(margins) / Math.abs(mean(margins)) > 0.35) dock(15, 'Cash flow has swung a lot from year to year.');
    if (valuation.meta.rows.some(r => r.fcf < 0)) dock(10, 'Free cash flow has been negative in a recent year.');
    if (co.ttm.netIncome < 0) dock(10, 'The company made a loss over the latest period.');
    if (valuation.meta.captive || valuation.meta.carMaker) dock(15, 'A finance arm makes the debt harder to judge.');
    if (co.balance.debt == null) dock(15, 'Debt could not be found in the filings.');
  }
  if (!valuation.meta.cost.betaKnown) dock(5, 'Share risk data was missing, so a market-average figure was used.');
  if (range.base > 0 && (range.bull - range.bear) / range.base > 1) dock(10, 'The range between low and high is very wide.');
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
  const earnings = co.ttm.netIncome;
  if (earnings > 0) {
    const pe = marketCap / earnings;
    const history = (peHistory ?? []).filter(v => v > 0 && v < 500);
    let note = 'No past figures available to compare.';
    if (history.length >= 3) {
      const usual = median(history);
      const gap = pe / usual - 1;
      const word = Math.abs(gap) < 0.1 ? 'Close to' : gap > 0 ? 'Above' : 'Below';
      note = `${word} its usual ${usual.toFixed(1)}.`;
    }
    checks.push({ label: 'Price to earnings', value: pe.toFixed(1), note });
  } else if (earnings != null) {
    checks.push({ label: 'Price to earnings', value: 'n/a', note: 'The company made a loss over this period.' });
  }
  if (valuation?.kind === 'dcf') {
    const fcf = valuation.meta.ttmMargin != null ? valuation.meta.ttmMargin * co.ttm.revenue : null;
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

// Builds everything the page needs for one company.
export function analyse(co, marketInput = {}) {
  const market = { ...marketInput };
  const finnhubShares = market.finnhubShares;
  const secShares = co.shares?.val;
  if (finnhubShares > 0 && (!secShares || Math.abs(finnhubShares / secShares - 1) > 0.1)) {
    market.shareMismatch = Boolean(secShares);
    co = { ...co, shares: { val: finnhubShares, source: 'market data' } };
  }
  market.sharesUsed = co.shares?.val;

  const tax = taxRate(co.annual);
  const type = classify(co, tax);
  const warnings = [];
  const label = TYPE_LABELS[type];

  if (type === 'lossMaking' || type === 'blank' || !co.shares) {
    const reason = !co.shares
      ? 'Its share count could not be found in the filings, so a per-share value is not possible.'
      : type === 'blank'
        ? 'It is a shell company with no real business to value yet.'
        : 'It has not produced steady cash or profit, so any fair value would be a guess about the far future.';
    return { type, label, co, market, fairValueAvailable: false, reason, checks: senseChecks(co, market, null), warnings };
  }

  const valuation = type === 'financial' ? buildResidual(co, market, warnings) : buildDcf(co, market, type, warnings);
  if (valuation.kind === 'residual' && !(valuation.fixed.bvps > 0)) {
    return { type, label, co, market, fairValueAvailable: false, reason: 'Its book value is zero or negative, so this method cannot be used.', checks: senseChecks(co, market, null), warnings };
  }
  companyWarnings(co, market, warnings, type);
  const range = valueRange(valuation, valuation.assumptions);
  return {
    type,
    label,
    co,
    market,
    valuation,
    fairValueAvailable: true,
    range,
    confidence: confidence(co, type, valuation, range),
    checks: senseChecks(co, market, valuation),
    warnings,
  };
}
