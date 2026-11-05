// Turns the SEC's raw "company facts" JSON into a tidy set of figures.
// Companies change the labels they use over time, so each figure has a list
// of labels to try. Nothing here touches the network or the page.

export class UnsupportedFilerError extends Error {}

const MS_PER_DAY = 864e5;
const ANNUAL_FORM = /^(10-K|20-F|40-F)/;
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / MS_PER_DAY;

const TAGS = {
  revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet',
    'RevenuesNetOfInterestExpense', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  opIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic', 'ProfitLoss'],
  pretax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  tax: ['IncomeTaxExpenseBenefit'],
  ocf: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets',
    'PaymentsForCapitalImprovements', 'PaymentsToAcquireOtherPropertyPlantAndEquipment'],
  sbc: ['ShareBasedCompensation', 'AllocatedShareBasedCompensationExpense'],
  interest: ['InterestExpense', 'InterestExpenseNonoperating', 'InterestExpenseDebt', 'InterestPaidNet'],
  dividends: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
};

function bestPerPeriod(entries, keyOf) {
  const map = new Map();
  for (const e of entries) {
    if (typeof e.val !== 'number' || !e.end) continue;
    const key = keyOf(e);
    const held = map.get(key);
    if (!held || (e.filed ?? '') >= (held.filed ?? '')) map.set(key, e);
  }
  return map;
}

// Combines every label for a figure. The label with the newest data goes
// first; older labels only fill gaps. Revenue uses the largest value for a
// period because a part of revenue can never exceed the total.
function mergedFlows(gaap, tags, mode = 'first') {
  const periodKey = e => `${e.start}|${e.end}`;
  const perTag = tags.map(tag => {
    const entries = (gaap[tag]?.units?.USD ?? []).filter(e => e.start);
    const best = bestPerPeriod(entries, periodKey);
    // Later quarterly filings can repeat a full-year figure, so remember
    // that the period also appeared in an annual report.
    for (const e of entries) {
      const held = best.get(periodKey(e));
      if (held && ANNUAL_FORM.test(e.form ?? '')) best.set(periodKey(e), { ...held, annual: true });
    }
    return best;
  }).filter(map => map.size);
  const newest = map => [...map.values()].reduce((max, e) => (e.end > max ? e.end : max), '');
  perTag.sort((a, b) => newest(b).localeCompare(newest(a)));
  const merged = new Map();
  for (const map of perTag) {
    for (const [key, e] of map) {
      const held = merged.get(key);
      const annual = Boolean(held?.annual || e.annual);
      if (!held || (mode === 'max' && e.val > held.val)) merged.set(key, { ...e, annual });
      else if (annual && !held.annual) merged.set(key, { ...held, annual });
    }
  }
  return [...merged.values()];
}

function annualOf(entries) {
  const yearly = entries.filter(e => {
    const length = daysBetween(e.start, e.end);
    return length >= 330 && length <= 385 && e.annual;
  });
  return bestPerPeriod(yearly, e => e.end);
}

// Trailing twelve months = last full year + this year so far - same period last year.
function trailing(entries, lastAnnual) {
  if (!lastAnnual) return null;
  const sameStart = entries.filter(e => {
    const fromYearEnd = daysBetween(lastAnnual.end, e.start);
    const length = daysBetween(e.start, e.end);
    return fromYearEnd >= -7 && fromYearEnd <= 7 && e.end > lastAnnual.end && length >= 80 && length <= 300;
  });
  if (!sameStart.length) return null;
  const current = sameStart.reduce((a, b) => (b.end > a.end ? b : a));
  const currentLength = daysBetween(current.start, current.end);
  const prior = entries
    .filter(e => Math.abs(daysBetween(e.end, current.end) - 365) <= 10
      && Math.abs(daysBetween(e.start, e.end) - currentLength) <= 10)
    .sort((a, b) => (a.filed ?? '').localeCompare(b.filed ?? '')).at(-1);
  if (!prior) return null;
  return { val: lastAnnual.val + current.val - prior.val, end: current.end };
}

function instantSeries(gaap, tags) {
  const series = new Map();
  for (const tag of tags) {
    const entries = (gaap[tag]?.units?.USD ?? []).filter(e => !e.start);
    for (const [end, e] of bestPerPeriod(entries, x => x.end)) if (!series.has(end)) series.set(end, e.val);
  }
  return series;
}

function balanceSheet(gaap) {
  const assets = instantSeries(gaap, ['Assets']);
  const equity = instantSeries(gaap, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const asOf = [...assets.keys(), ...equity.keys()].sort().at(-1) ?? null;
  const at = (...tags) => {
    for (const tag of tags) {
      const series = instantSeries(gaap, [tag]);
      if (series.has(asOf)) return series.get(asOf);
      for (const [end, val] of series) if (Math.abs(daysBetween(end, asOf)) <= 10) return val;
    }
    return null;
  };
  const n = value => value ?? 0;

  const shortTerm = Math.max(n(at('ShortTermBorrowings')), n(at('CommercialPaper')));
  const longNoncurrent = at('LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations');
  const longCurrent = at('LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent');
  const candidates = [
    at('DebtLongtermAndShorttermCombinedAmount', 'DebtInstrumentCarryingAmount'),
    n(at('DebtCurrent')) + n(longNoncurrent),
    n(at('LongTermDebt')) + shortTerm,
    n(longNoncurrent) + n(longCurrent) + shortTerm,
  ].filter(v => v != null);
  const debtKnown = candidates.some(v => v > 0);

  const whole = at('FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLoss',
    'NotesReceivableNet', 'LoansAndLeasesReceivableNetReportedAmount');
  const split = n(at('NotesAndLoansReceivableNetCurrent', 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossCurrent'))
    + n(at('NotesAndLoansReceivableNetNoncurrent', 'FinancingReceivableExcludingAccruedInterestAfterAllowanceForCreditLossNoncurrent'));

  const longTermPieces = n(at('EquityMethodInvestments')) + n(at('MarketableSecuritiesNoncurrent', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent'));

  return {
    asOf,
    cash: at('CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'),
    shortTermInvestments: n(at('ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecurities', 'MarketableSecurities')),
    longTermInvestments: Math.max(n(at('LongTermInvestments')), longTermPieces),
    debt: debtKnown ? Math.max(...candidates) : null,
    equity: equity.has(asOf) ? equity.get(asOf) : null,
    preferred: n(at('PreferredStockValue')),
    noncontrolling: n(at('MinorityInterest')),
    goodwill: n(at('Goodwill')),
    intangibles: n(at('IntangibleAssetsNetExcludingGoodwill')),
    assets: assets.has(asOf) ? assets.get(asOf) : null,
    financeReceivables: Math.max(n(whole), split),
  };
}

function shareCount(facts, gaap) {
  const latest = entries => entries.filter(e => typeof e.val === 'number' && e.val > 0)
    .sort((a, b) => (a.end + (a.filed ?? '')).localeCompare(b.end + (b.filed ?? ''))).at(-1);
  const cover = latest(facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? []);
  if (cover) return { val: cover.val, end: cover.end, source: 'latest filing cover page' };
  const balance = latest((gaap.CommonStockSharesOutstanding?.units?.shares ?? []));
  if (balance) return { val: balance.val, end: balance.end, source: 'latest balance sheet' };
  const weighted = latest(gaap.WeightedAverageNumberOfDilutedSharesOutstanding?.units?.shares ?? []);
  if (weighted) return { val: weighted.val, end: weighted.end, source: 'average diluted shares' };
  return null;
}

// Joins a new holding company's filings to the history of the company it replaced.
export function mergeFacts(current, previous) {
  const merged = structuredClone(current);
  const target = merged.facts['us-gaap'] ??= {};
  for (const [tag, fact] of Object.entries(previous.facts?.['us-gaap'] ?? {})) {
    target[tag] ??= { units: {} };
    for (const [unit, entries] of Object.entries(fact.units)) {
      target[tag].units[unit] = [...entries, ...(target[tag].units[unit] ?? [])];
    }
  }
  return merged;
}

export function extractCompany(factsFile, submissions = {}) {
  const facts = factsFile?.facts ?? {};
  const gaap = facts['us-gaap'];
  const name = factsFile?.entityName || submissions.name || 'This company';
  if (!gaap) {
    if (facts['ifrs-full']) throw new UnsupportedFilerError(`${name} reports under international accounting rules, which this version does not read.`);
    throw new UnsupportedFilerError(`${name} has no usable financial data at the SEC. Funds and very new listings often don't.`);
  }
  if (gaap.Assets?.units && !gaap.Assets.units.USD) {
    throw new UnsupportedFilerError(`${name} reports in a currency other than US dollars, which this version does not read.`);
  }

  const flows = {};
  const annualMaps = {};
  for (const [key, tags] of Object.entries(TAGS)) {
    flows[key] = mergedFlows(gaap, tags, key === 'revenue' ? 'max' : 'first');
    annualMaps[key] = annualOf(flows[key]);
  }

  const equitySeries = instantSeries(gaap, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']);
  const ends = [...new Set([...annualMaps.revenue.keys(), ...annualMaps.netIncome.keys()])].sort().slice(-6);
  const annual = ends.map(end => {
    const row = { end, equity: equitySeries.get(end) ?? null };
    for (const key of Object.keys(TAGS)) row[key] = annualMaps[key].get(end)?.val ?? null;
    if (row.capex != null) row.capex = Math.abs(row.capex);
    if (row.dividends != null) row.dividends = Math.abs(row.dividends);
    return row;
  });

  const ttmValues = {};
  for (const key of Object.keys(TAGS)) {
    const lastEnd = annual.at(-1)?.end;
    const last = annualMaps[key].get(lastEnd);
    ttmValues[key] = trailing(flows[key], last);
  }
  const core = ['revenue', 'ocf', 'capex'];
  const usable = core.every(key => ttmValues[key]) && core.every(key => ttmValues[key].end === ttmValues.revenue.end);
  const lastYear = annual.at(-1) ?? {};
  const ttm = { ...lastYear, isTrailing: usable };
  if (usable) {
    ttm.end = ttmValues.revenue.end;
    for (const key of Object.keys(TAGS)) {
      if (ttmValues[key]?.end === ttm.end) ttm[key] = ttmValues[key].val;
    }
    ttm.capex = Math.abs(ttm.capex);
  } else if (ttmValues.netIncome) {
    // Banks have no capex line, but their trailing profit still matters.
    ttm.netIncome = ttmValues.netIncome.val;
    ttm.netIncomeEnd = ttmValues.netIncome.end;
  }

  return {
    name,
    cik: factsFile.cik,
    sic: Number(submissions.sic) || null,
    sicDescription: submissions.sicDescription || null,
    annual,
    ttm,
    balance: balanceSheet(gaap),
    shares: shareCount(facts, gaap),
  };
}
