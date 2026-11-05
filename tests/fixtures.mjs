// Test data in the same shape as the SEC's company facts files.
// Annual figures are real published numbers from stockanalysis.com, read in
// November 2026. A few items are stated estimates, marked below. The year-to-
// date split is invented, but it is set so that the trailing totals match the
// published ones. Prices are recent closes and are only test inputs.

const M = 1e6;

function period(endDate, days) {
  const end = new Date(`${endDate}T00:00:00Z`);
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  return start.toISOString().slice(0, 10);
}

function addYear(endDate, offset) {
  const d = new Date(`${endDate}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + offset);
  return d.toISOString().slice(0, 10);
}

export function buildFacts({ name, cik, years, ttm, balance, shares, tagFor = {} }) {
  const gaap = {};
  const add = (tag, entry) => { (gaap[tag] ??= { units: { USD: [] } }).units.USD.push(entry); };
  const defaultTags = {
    revenue: 'RevenueFromContractWithCustomerExcludingAssessedTax', opIncome: 'OperatingIncomeLoss', netIncome: 'NetIncomeLoss',
    pretax: 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
    tax: 'IncomeTaxExpenseBenefit', ocf: 'NetCashProvidedByUsedInOperatingActivities',
    capex: 'PaymentsToAcquirePropertyPlantAndEquipment', sbc: 'ShareBasedCompensation', interest: 'InterestExpense',
    dividends: 'PaymentsOfDividendsCommonStock',
  };
  for (const y of years) {
    const filed = addYear(y.end, 0).slice(0, 4) + '-12-31';
    for (const [key, val] of Object.entries(y)) {
      if (key === 'end' || val == null) continue;
      const fy = Number(y.end.slice(0, 4));
      const tag = (typeof tagFor[key] === 'function' ? tagFor[key](fy) : tagFor[key]) ?? defaultTags[key];
      if (key === 'equity') {
        add('StockholdersEquity', { end: y.end, val: val * M, form: '10-K', filed });
      } else {
        add(tag, { start: period(y.end, 365), end: y.end, val: val * M, form: '10-K', filed });
      }
    }
  }
  if (ttm) {
    const last = years.at(-1);
    for (const [key, val] of Object.entries(ttm.values)) {
      const tag = (typeof tagFor[key] === 'function' ? tagFor[key](9999) : tagFor[key]) ?? defaultTags[key];
      const difference = val - last[key];
      const startActual = new Date(new Date(`${last.end}T00:00:00Z`).getTime() + 864e5).toISOString().slice(0, 10);
      const current = 1000 + Math.max(0, difference);
      add(tag, { start: startActual, end: ttm.end, val: current * M, form: '10-Q', filed: ttm.end });
      const priorEnd = addYear(ttm.end, -1);
      const priorStart = addYear(startActual, -1);
      add(tag, { start: priorStart, end: priorEnd, val: (current - difference) * M, form: '10-Q', filed: ttm.end });
    }
  }
  const asOf = balance.asOf;
  for (const [tag, val] of Object.entries(balance.items)) {
    add(tag, { end: asOf, val: val * M, form: '10-Q', filed: asOf });
  }
  return {
    cik,
    entityName: name,
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: asOf, val: shares * M, form: '10-Q', filed: asOf }] } } },
      'us-gaap': gaap,
    },
  };
}

export const COMPANIES = {
  KO: {
    cik: 21344, sic: 2080, price: 82.62, beta: 0.55, ticker: 'KO', displayName: 'Coca-Cola Co',
    sicDescription: 'Beverages',
    facts: buildFacts({
      name: 'COCA COLA CO', cik: 21344, shares: 4302,
      tagFor: { revenue: fy => (fy >= 2023 ? 'RevenueFromContractWithCustomerExcludingAssessedTax' : 'Revenues') },
      years: [
        { end: '2021-12-31', revenue: 38655, opIncome: 11433, netIncome: 9771, pretax: 12425, tax: 2621, ocf: 12625, capex: 1367, sbc: 337, dividends: 7252, equity: 22999 },
        { end: '2022-12-31', revenue: 43004, opIncome: 12341, netIncome: 9542, pretax: 11686, tax: 2115, ocf: 11018, capex: 1484, sbc: 356, dividends: 7616, equity: 24105 },
        { end: '2023-12-31', revenue: 45754, opIncome: 13246, netIncome: 10714, pretax: 12952, tax: 2249, ocf: 11599, capex: 1852, sbc: 254, dividends: 7952, equity: 25941 },
        { end: '2024-12-31', revenue: 47061, opIncome: 14292, netIncome: 10631, pretax: 13086, tax: 2437, ocf: 6805, capex: 2064, sbc: 286, dividends: 8359, equity: 24856 },
        { end: '2025-12-31', revenue: 47941, opIncome: 15028, netIncome: 13107, pretax: 15998, tax: 2861, ocf: 7408, capex: 2112, sbc: 279, dividends: 8779, equity: 32170 },
      ],
      ttm: { end: '2026-07-03', values: { revenue: 49100, ocf: 16342, capex: 2045, sbc: 266, netIncome: 13500 } },
      balance: {
        asOf: '2026-07-03',
        items: {
          Assets: 104816, StockholdersEquity: 34275, CashAndCashEquivalentsAtCarryingValue: 12000, ShortTermInvestments: 3806,
          LongTermInvestments: 22900, LongTermDebtNoncurrent: 42000, LongTermDebtCurrent: 3500, CommercialPaper: 2414, MinorityInterest: 1500,
        },
      },
    }),
  },
  NVDA: {
    cik: 1045810, sic: 3674, price: 205.19, beta: 1.7, ticker: 'NVDA', displayName: 'NVIDIA Corp',
    sicDescription: 'Semiconductors & Related Devices',
    facts: buildFacts({
      name: 'NVIDIA CORP', cik: 1045810, shares: 24300,
      years: [
        { end: '2022-01-30', revenue: 26914, opIncome: 10041, netIncome: 9752, pretax: 9941, tax: 189, ocf: 9108, capex: 976, sbc: 2004, equity: 26612 },
        { end: '2023-01-29', revenue: 26974, opIncome: 5577, netIncome: 4368, pretax: 4181, tax: -187, ocf: 5641, capex: 1833, sbc: 2709, equity: 22101 },
        { end: '2024-01-28', revenue: 60922, opIncome: 32972, netIncome: 29760, pretax: 33818, tax: 4058, ocf: 28090, capex: 1069, sbc: 3549, equity: 42978 },
        { end: '2025-01-26', revenue: 130497, opIncome: 81453, netIncome: 72880, pretax: 84026, tax: 11146, ocf: 64089, capex: 3236, sbc: 4737, equity: 79327 },
        { end: '2026-01-25', revenue: 215938, opIncome: 130387, netIncome: 120067, pretax: 141450, tax: 21383, ocf: 102718, capex: 6042, sbc: 6386, equity: 157000 },
      ],
      ttm: { end: '2026-07-26', values: { revenue: 302970, ocf: 134360, capex: 7354, sbc: 7500, netIncome: 192880 } },
      balance: {
        asOf: '2026-07-26',
        items: {
          Assets: 300000, StockholdersEquity: 230000, CashAndCashEquivalentsAtCarryingValue: 20000, MarketableSecuritiesCurrent: 42469,
          LongTermDebtNoncurrent: 34000, LongTermDebtCurrent: 4860,
        },
      },
    }),
  },
  F: {
    // Finance receivables of $96bn are an estimate for this test; the page read did not show them.
    cik: 37996, sic: 3711, price: 13.5, beta: 1.5, ticker: 'F', displayName: 'Ford Motor Co',
    sicDescription: 'Motor Vehicles & Passenger Car Bodies',
    facts: buildFacts({
      name: 'FORD MOTOR CO', cik: 37996, shares: 3990,
      tagFor: { revenue: 'Revenues' },
      years: [
        { end: '2021-12-31', revenue: 136341, opIncome: 6717, netIncome: 17937, ocf: 15787, capex: 6227 },
        { end: '2022-12-31', revenue: 158057, opIncome: 8080, netIncome: -1981, ocf: 6853, capex: 6866 },
        { end: '2023-12-31', revenue: 176191, opIncome: 2964, netIncome: 4347, ocf: 14918, capex: 8236 },
        { end: '2024-12-31', revenue: 184992, opIncome: 5630, netIncome: 5879, ocf: 15423, capex: 8684 },
        { end: '2025-12-31', revenue: 187267, opIncome: -602, netIncome: -8182, ocf: 21282, capex: 8815 },
      ],
      balance: {
        asOf: '2026-06-30',
        items: {
          Assets: 290000, StockholdersEquity: 36000, CashAndCashEquivalentsAtCarryingValue: 22120,
          DebtCurrent: 60000, LongTermDebtNoncurrent: 103296, NotesAndLoansReceivableNetCurrent: 46000, NotesAndLoansReceivableNetNoncurrent: 50000,
        },
      },
    }),
  },
  JPM: {
    cik: 19617, sic: 6021, price: 320.72, beta: 1.05, ticker: 'JPM', displayName: 'JPMorgan Chase & Co',
    sicDescription: 'National Commercial Banks',
    facts: buildFacts({
      name: 'JPMORGAN CHASE & CO', cik: 19617, shares: 2656,
      tagFor: { revenue: 'Revenues' },
      years: [
        { end: '2021-12-31', revenue: 121649, netIncome: 48330, equity: 294127 },
        { end: '2022-12-31', revenue: 128641, netIncome: 37680, equity: 292332 },
        { end: '2023-12-31', revenue: 158104, netIncome: 49550, equity: 327878 },
        { end: '2024-12-31', revenue: 177556, netIncome: 58470, equity: 344758 },
        { end: '2025-12-31', revenue: 182447, netIncome: 57050, equity: 362438 },
      ],
      balance: {
        asOf: '2026-09-30',
        items: { Assets: 5091545, StockholdersEquity: 372368, PreferredStockValue: 21040, Goodwill: 52717 },
      },
    }),
  },
  LOSS: {
    cik: 999001, sic: 2836, price: 8, beta: 1.6, ticker: 'LOSS',
    sicDescription: 'Biological Products',
    facts: buildFacts({
      name: 'EXAMPLE BIOTECH INC', cik: 999001, shares: 200,
      years: [
        { end: '2023-12-31', revenue: 20, netIncome: -300, ocf: -250, capex: 10 },
        { end: '2024-12-31', revenue: 25, netIncome: -350, ocf: -280, capex: 12 },
        { end: '2025-12-31', revenue: 30, netIncome: -400, ocf: -310, capex: 14 },
      ],
      balance: { asOf: '2026-09-30', items: { Assets: 900, StockholdersEquity: 700, CashAndCashEquivalentsAtCarryingValue: 800 } },
    }),
  },
};

export const TICKERS = {
  0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
  1: { cik_str: 21344, ticker: 'KO', title: 'COCA COLA CO' },
  2: { cik_str: 37996, ticker: 'F', title: 'FORD MOTOR CO' },
  3: { cik_str: 19617, ticker: 'JPM', title: 'JPMORGAN CHASE & CO' },
  4: { cik_str: 999001, ticker: 'LOSS', title: 'EXAMPLE BIOTECH INC' },
  5: { cik_str: 1067983, ticker: 'BRK-B', title: 'BERKSHIRE HATHAWAY INC' },
};
