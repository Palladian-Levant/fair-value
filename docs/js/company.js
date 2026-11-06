// The detailed data sections on a company page.

const $ = id => document.getElementById(id);
const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
};
const money = value => `$${Math.round(value).toLocaleString('en-US')}`;
const bigMoney = value => {
  if (value == null) return null;
  const size = Math.abs(value);
  if (size >= 1e12) return `$${(value / 1e12).toFixed(2)}tn`;
  if (size >= 1e9) return `$${(value / 1e9).toFixed(1)}bn`;
  if (size >= 1e6) return `$${(value / 1e6).toFixed(1)}m`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
};
const pct = value => (value == null ? null : `${value.toFixed(1)}%`);
const signed = value => (value == null ? null : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}%`);
const times = value => (value == null ? null : value.toFixed(1));
const shortDate = text => new Date(text).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const SCORE_NAMES = { overall: 'Overall', value: 'Value', growth: 'Growth', profitability: 'Profitability', strength: 'Financial strength', momentum: 'Momentum' };

function renderScores(market) {
  const scores = market.scores;
  $('scores-section').hidden = !scores;
  if (!scores) return;
  $('scores').replaceChildren(...Object.entries(SCORE_NAMES).map(([key, label]) => {
    const value = scores[key];
    const row = make('div', key === 'overall' ? 'score overall' : 'score');
    row.append(make('span', 'score-name', label));
    const track = make('span', 'score-track');
    const fill = make('span', 'score-fill');
    fill.style.width = value == null ? '0' : `${((value - 1) / 4) * 100}%`;
    track.append(fill);
    row.append(track, make('span', 'score-value', value == null ? 'n/a' : `${value.toFixed(1)} / 5`));
    return row;
  }));
}

function statGroups(a) {
  const s = a.market.stats ?? {};
  const shares = a.market.sharesUsed;
  const cap = a.market.price && shares ? a.market.price * shares : null;
  const fcfYield = s.pfcfShareTTM > 0 ? 100 / s.pfcfShareTTM : null;
  const expected = s.forwardPE > 0 && s.forwardPEG > 0 ? s.forwardPE / s.forwardPEG : null;
  return [
    ['Valuation', [['Market value', bigMoney(cap)], ['Enterprise value', s.enterpriseValue ? bigMoney(s.enterpriseValue * 1e6) : null], ['P/E', times(s.peTTM)], ['Forward P/E', times(s.forwardPE)], ['Forward PEG', s.forwardPEG?.toFixed(2)], ['EV/EBITDA', times(s.evEbitdaTTM)], ['P/S', times(s.psTTM)], ['P/B', times(s.pb)], ['Free cash flow yield', pct(fcfYield)]]],
    ['Growth', [['Revenue, last year', signed(s.revenueGrowthTTMYoy)], ['Revenue, latest quarter', signed(s.revenueGrowthQuarterlyYoy)], ['Revenue, 3 years', signed(s.revenueGrowth3Y)], ['Revenue, 5 years', signed(s.revenueGrowth5Y)], ['Earnings, 3 years', signed(s.epsGrowth3Y)], ['Earnings, 5 years', signed(s.epsGrowth5Y)], ['Analysts expect', signed(expected)]]],
    ['Profitability', [['Gross margin', pct(s.grossMarginTTM)], ['Operating margin', pct(s.operatingMarginTTM)], ['Net margin', pct(s.netProfitMarginTTM)], ['Return on equity', pct(s.roeTTM)], ['Return on investment', pct(s.roiTTM)], ['Return on assets', pct(s.roaTTM)]]],
    ['Financial strength', [['Debt to equity', s['totalDebt/totalEquityQuarterly']?.toFixed(2)], ['Current ratio', s.currentRatioQuarterly?.toFixed(2)], ['Quick ratio', s.quickRatioQuarterly?.toFixed(2)], ['Interest cover', times(s.netInterestCoverageTTM)], ['Beta', s.beta?.toFixed(2)]]],
    ['Dividends', [['Yield', pct(s.dividendYieldIndicatedAnnual)], ['Per share', s.dividendPerShareTTM ? `$${s.dividendPerShareTTM.toFixed(2)}` : null], ['Payout ratio', pct(s.payoutRatioTTM)], ['5-year growth', signed(s.dividendGrowthRate5Y)]]],
    ['Price performance', [['1 week', signed(s['5DayPriceReturnDaily'])], ['3 months', signed(s['13WeekPriceReturnDaily'])], ['6 months', signed(s['26WeekPriceReturnDaily'])], ['1 year', signed(s['52WeekPriceReturnDaily'])], ['This year', signed(s.yearToDatePriceReturnDaily)], ['1 year against S&P 500', signed(s['priceRelativeToS&P50052Week'])], ['52-week range', s['52WeekLow'] ? `$${s['52WeekLow'].toFixed(2)} to $${s['52WeekHigh'].toFixed(2)}` : null]]],
  ];
}

function renderStats(a) {
  const groups = statGroups(a).map(([title, rows]) => [title, rows.filter(([, value]) => value != null && value !== 'NaN')]).filter(([, rows]) => rows.length);
  $('stats-section').hidden = !groups.length;
  $('stats').replaceChildren(...groups.map(([title, rows]) => {
    const group = make('section', 'stat-group');
    group.append(make('h4', null, title));
    const list = make('dl');
    for (const [label, value] of rows) {
      const line = make('div');
      line.append(make('dt', null, label), make('dd', null, value));
      list.append(line);
    }
    group.append(list);
    return group;
  }));
}

const SVG = 'http://www.w3.org/2000/svg';
const svgPart = (tag, attributes, text) => {
  const part = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value);
  if (text != null) part.textContent = text;
  return part;
};

function barChart(title, points, format) {
  const box = make('figure', 'chart');
  box.append(make('figcaption', null, title));
  const width = 320;
  const height = 150;
  const base = 124;
  const top = 18;
  const values = points.map(point => point.value);
  const high = Math.max(...values, 0);
  const low = Math.min(...values, 0);
  const scale = (base - top) / ((high - low) || 1);
  const zero = base - (0 - low) * scale;
  const step = width / points.length;
  const svg = svgPart('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${title}: ${points.map(p => `${p.label} ${format(p.value)}`).join(', ')}` });
  points.forEach((point, index) => {
    const bar = Math.max(Math.abs(point.value) * scale, 1);
    const y = point.value >= 0 ? zero - bar : zero;
    const x = index * step + step * 0.2;
    const rect = svgPart('rect', { x, y, width: step * 0.6, height: bar, rx: 3, class: point.value >= 0 ? 'bar' : 'bar negative' });
    rect.append(svgPart('title', {}, `${point.label}: ${format(point.value)}`));
    svg.append(rect);
    svg.append(svgPart('text', { x: x + step * 0.3, y: height - 8, class: 'axis' }, point.label));
    if (index === points.length - 1 || index === 0) svg.append(svgPart('text', { x: x + step * 0.3, y: Math.max(y - 5, 11), class: 'value' }, format(point.value)));
  });
  box.append(svg);
  return box;
}

function renderCharts(a) {
  const { annual } = a.co;
  const year = row => `’${row.end.slice(2, 4)}`;
  const charts = [];
  const billions = value => `$${(value / 1e9).toFixed(0)}bn`;
  const revenue = annual.filter(r => r.revenue != null).map(r => ({ label: year(r), value: r.revenue }));
  if (revenue.length >= 3) charts.push(barChart('Revenue', revenue, billions));
  const profit = annual.filter(r => r.opIncome != null).map(r => ({ label: year(r), value: r.opIncome }));
  if (profit.length >= 3) charts.push(barChart('Operating profit', profit, billions));
  const series = a.market.series ?? {};
  const pe = [...(series.pe ?? [])].reverse().filter(([, v]) => v > 0).map(([label, value]) => ({ label: `’${label.slice(2)}`, value: Math.min(value, 100) }));
  if (pe.length >= 3) charts.push(barChart('Price to earnings at each year end', pe, value => value.toFixed(0)));
  const roic = [...(series.roic ?? [])].reverse().map(([label, value]) => ({ label: `’${label.slice(2)}`, value: value * 100 }));
  if (roic.length >= 3) charts.push(barChart('Return on invested capital', roic, value => `${value.toFixed(0)}%`));
  $('charts-section').hidden = !charts.length;
  $('charts').replaceChildren(...charts);
}

function renderTarget(a) {
  const target = a.market.fmp?.target;
  const box = $('target');
  box.hidden = !target;
  if (!target) return;
  const price = a.market.price;
  const upside = price ? (target.consensus / price - 1) * 100 : null;
  box.replaceChildren(
    make('span', 'figure', money(target.consensus)),
    make('span', 'note', `Average analyst price target${upside != null ? `, ${signed(upside)} from the share price` : ''}. Targets range from ${money(target.low)} to ${money(target.high)}.`),
  );
}

function renderForecasts(a) {
  const years = a.market.fmp?.estimates ?? [];
  const table = $('forecast-table');
  table.hidden = !years.length;
  if (!years.length) return;
  const last = a.co.annual.at(-1);
  const head = make('thead');
  const headRow = head.insertRow();
  for (const text of ['Year', 'Revenue', 'Growth', 'Operating margin', 'Earnings per share']) headRow.append(make('th', null, text));
  const body = make('tbody');
  let previous = last?.revenue;
  for (const year of years) {
    const row = body.insertRow();
    row.insertCell().textContent = `Year to ${year.end.slice(0, 7)}`;
    row.insertCell().textContent = bigMoney(year.revenue);
    row.insertCell().textContent = previous > 0 ? signed((year.revenue / previous - 1) * 100) : 'n/a';
    row.insertCell().textContent = year.ebit != null && year.revenue > 0 ? pct((year.ebit / year.revenue) * 100) : 'n/a';
    row.insertCell().textContent = year.eps != null ? `$${year.eps.toFixed(2)}` : 'n/a';
    previous = year.revenue;
  }
  table.replaceChildren(head, body);
}

function renderAnalysts(a) {
  const fmpGrades = a.market.fmp?.grades;
  const latest = fmpGrades && fmpGrades.buy + fmpGrades.hold + fmpGrades.sell > 0 ? fmpGrades : a.market.slow?.analysts?.[0];
  const earnings = a.market.slow?.earnings ?? [];
  const s = a.market.stats ?? {};
  const years = a.market.fmp?.estimates ?? [];
  const total = latest ? latest.strongBuy + latest.buy + latest.hold + latest.sell + latest.strongSell : 0;
  $('analysts-section').hidden = !total && !earnings.length && !years.length && !a.market.fmp?.target;
  renderTarget(a);
  renderForecasts(a);
  const summary = [];
  if (total) {
    const buys = latest.strongBuy + latest.buy;
    summary.push(`${buys} of ${total} analyst ratings are buys, ${latest.hold} holds and ${latest.sell + latest.strongSell} sells.`);
  }
  if (years[0]?.analysts) {
    summary.push(`Forecasts below are the average of ${years[0].analysts} analysts.`);
  } else if (s.forwardPE > 0 && a.market.price) {
    summary.push(`Expected earnings per share are about $${(a.market.price / s.forwardPE).toFixed(2)}.`);
  }
  $('analyst-summary').textContent = summary.join(' ');
  const bar = $('analyst-bar');
  bar.hidden = !total;
  if (total) {
    const part = (className, count) => {
      const piece = make('span', className);
      piece.style.flexGrow = count;
      return piece;
    };
    bar.replaceChildren(part('buy', latest.strongBuy + latest.buy), part('hold', latest.hold), part('sell', latest.sell + latest.strongSell));
  }
  const table = $('earnings-table');
  table.hidden = !earnings.length;
  const head = make('thead');
  const row = head.insertRow();
  for (const text of ['Quarter', 'Expected', 'Actual', 'Surprise']) row.append(make('th', null, text));
  const body = make('tbody');
  for (const entry of earnings) {
    const line = body.insertRow();
    line.insertCell().textContent = entry.period?.slice(0, 7) ?? '';
    line.insertCell().textContent = entry.estimate != null ? `$${entry.estimate.toFixed(2)}` : 'n/a';
    line.insertCell().textContent = entry.actual != null ? `$${entry.actual.toFixed(2)}` : 'n/a';
    line.insertCell().textContent = entry.surprise != null ? signed(entry.surprise) : 'n/a';
  }
  table.replaceChildren(head, body);
}

function renderPeers(a, rows) {
  const tickers = a.market.slow?.peers ?? [];
  const found = tickers.map(ticker => rows.find(row => row.ticker === ticker)).filter(Boolean).slice(0, 7);
  $('peers-section').hidden = !found.length;
  if (!found.length) return;
  const table = $('peers-table');
  const head = make('thead');
  const headRow = head.insertRow();
  for (const text of ['Company', 'Price', 'Fair value', 'Upside', 'Score']) headRow.append(make('th', null, text));
  const body = make('tbody');
  for (const peer of found) {
    const row = body.insertRow();
    const link = make('a', null, peer.name);
    link.href = `./?t=${encodeURIComponent(peer.ticker)}`;
    row.insertCell().append(link);
    row.insertCell().textContent = `$${peer.price.toFixed(2)}`;
    row.insertCell().textContent = money(peer.fair);
    row.insertCell().textContent = signed(peer.gap * 100);
    row.insertCell().textContent = peer.score != null ? peer.score.toFixed(1) : 'n/a';
  }
  table.replaceChildren(head, body);
}

function renderInsiders(a) {
  const insiders = a.market.slow?.insiders;
  const active = insiders && insiders.buys + insiders.sells > 0;
  $('insiders-section').hidden = !insiders;
  if (!insiders) return;
  $('insiders').textContent = active
    ? `In the last 6 months, insiders made ${insiders.buys} ${insiders.buys === 1 ? 'purchase' : 'purchases'} worth ${bigMoney(insiders.bought) ?? '$0'} and ${insiders.sells} ${insiders.sells === 1 ? 'sale' : 'sales'} worth ${bigMoney(insiders.sold) ?? '$0'}. Sales are often routine, so purchases tend to say more.`
    : 'No insider purchases or sales were reported in the last 6 months.';
}

function renderNews(a) {
  const news = (a.market.slow?.news ?? []).filter(item => /^https:\/\//.test(item.url ?? ''));
  $('news-section').hidden = !news.length;
  $('news').replaceChildren(...news.map(item => {
    const entry = make('li');
    const link = make('a', null, item.headline);
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    entry.append(link, make('span', 'note', `${item.source}, ${shortDate(item.time * 1000)}`));
    return entry;
  }));
}

export function renderCompanyData(a, screenerRows = []) {
  renderScores(a.market);
  renderStats(a);
  renderCharts(a);
  renderAnalysts(a);
  renderPeers(a, screenerRows);
  renderInsiders(a);
  renderNews(a);
}

export function hideCompanyData() {
  for (const id of ['scores-section', 'stats-section', 'charts-section', 'analysts-section', 'peers-section', 'insiders-section', 'news-section']) $(id).hidden = true;
}
