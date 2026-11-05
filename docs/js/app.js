import { loadCompanies, loadScreener, searchTickers } from './api.js';
import { renderCompanyData } from './company.js';
import { analyse, FORECAST_WEIGHT, impliedByPrice, valueRange } from './model.js';
import { initScreener } from './screener.js';

const $ = id => document.getElementById(id);
const input = $('ticker');
const list = $('suggestions');
const money = value => `$${value.toLocaleString('en-US', { minimumFractionDigits: value >= 1000 ? 0 : 2, maximumFractionDigits: value >= 1000 ? 0 : 2 })}`;
const whole = value => `$${Math.round(value).toLocaleString('en-US')}`;
const percent = (value, digits = 1) => `${(value * 100).toFixed(digits)}%`;
const billions = value => (value == null ? 'n/a' : `$${(value / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 })}bn`);

let state = null;
let matches = [];
let activeIndex = -1;

function setStatus(message, kind = 'info') {
  const status = $('status');
  status.textContent = message;
  status.dataset.kind = kind;
  status.hidden = !message;
}

function sizeInput() {
  input.style.width = `${Math.max(3.2, input.value.length + 0.7)}ch`;
}

function closeList() {
  list.hidden = true;
  list.replaceChildren();
  matches = [];
  activeIndex = -1;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderList() {
  list.replaceChildren(...matches.map((row, index) => {
    const item = document.createElement('li');
    item.id = `option-${index}`;
    item.role = 'option';
    item.setAttribute('aria-selected', String(index === activeIndex));
    const ticker = document.createElement('b');
    ticker.textContent = row.ticker;
    const name = document.createElement('span');
    name.textContent = row.title;
    item.append(ticker, name);
    item.addEventListener('mousedown', event => { event.preventDefault(); choose(row); });
    return item;
  }));
  list.hidden = !matches.length;
  input.setAttribute('aria-expanded', String(matches.length > 0));
  if (activeIndex >= 0) input.setAttribute('aria-activedescendant', `option-${activeIndex}`);
  else input.removeAttribute('aria-activedescendant');
}

async function suggest() {
  sizeInput();
  if (!input.value.trim()) { closeList(); return; }
  try {
    const { list: tickers } = await loadCompanies();
    matches = searchTickers(tickers, input.value);
    activeIndex = -1;
    if (document.activeElement === input) renderList();
  } catch {
    closeList();
  }
}

function choose(row) {
  input.value = row.ticker;
  sizeInput();
  closeList();
  run(row);
}

const NOT_READY = 'The first update has not finished yet. Check back soon.';

async function submit(text) {
  const query = text.trim();
  if (!query) { setStatus('Type a ticker or company name first.'); return; }
  setStatus('Looking up the company.');
  try {
    const { list: tickers } = await loadCompanies();
    const [best] = searchTickers(tickers, query, 1);
    if (!best) {
      $('result').hidden = true;
      setStatus(`"${query}" is not in the list. The site covers the largest US companies that report to the SEC.`, 'error');
      return;
    }
    choose(best);
  } catch (error) {
    setStatus(error.status === 404 ? NOT_READY : `The company list could not be loaded. ${error.message}`, 'error');
  }
}

async function run(row) {
  $('result').hidden = true;
  $('hint').hidden = true;
  $('examples').hidden = true;
  const url = new URL(location.href);
  url.searchParams.set('t', row.ticker);
  history.replaceState(null, '', url);
  try {
    const { companies } = await loadCompanies();
    const entry = companies[row.ticker];
    const analysis = analyse(entry.co, entry.market);
    state = { analysis, row, assumptions: analysis.valuation ? { ...analysis.valuation.assumptions } : null };
    setStatus('');
    render();
  } catch (error) {
    setStatus(error.status === 404 ? NOT_READY : `${row.title} could not be loaded. ${error.message}`, 'error');
  }
}

function displayName(a) {
  return titleCase(a.market.companyName || a.co.name);
}

function titleCase(name) {
  const tidy = text => text.replace(/\b(Inc|Corp|Corporation|Co|Plc|Ltd|Llc)\b\.?/g, '').replace(/\s+/g, ' ').replace(/[\s,&]+$/, '').trim();
  if (/[a-z]/.test(name)) return tidy(name);
  return name.toLowerCase().replace(/(^|[\s&.-])([a-z])/g, (m, gap, letter) => gap + letter.toUpperCase())
    .replace(/\b(Inc|Corp|Co|Plc|Ltd|Llc)\b\.?/g, '').replace(/\s+/g, ' ').replace(/[\s,&]+$/, '').trim();
}

function renderScale(range, price) {
  const scale = $('scale');
  const points = [range.bear, range.base, range.bull, price].filter(v => v != null);
  const low = Math.min(0, ...points);
  const high = Math.max(...points) * 1.08;
  const spot = value => `${((value - low) / (high - low)) * 100}%`;
  const part = (className, value) => {
    const element = document.createElement('div');
    element.className = className;
    element.style.left = spot(value);
    return element;
  };
  const tag = (position, label, value, format = whole) => {
    const element = part(`tag ${position}`, value);
    const fraction = (value - low) / (high - low);
    if (fraction < 0.1) element.classList.add('start');
    if (fraction > 0.9) element.classList.add('end');
    const figure = document.createElement('b');
    figure.textContent = format(value);
    element.append(figure, label);
    return element;
  };
  const rail = document.createElement('div');
  rail.className = 'rail';
  const band = part('band', range.bear);
  band.style.width = `calc(${spot(range.bull)} - ${spot(range.bear)})`;

  const pieces = [rail, band, part('mark', range.base)];
  pieces.push(tag('lower', 'Fair value', range.base));
  const gap = (high - low) * 0.17;
  if (range.base - range.bear >= gap) pieces.push(tag('lower', 'Low', range.bear));
  if (range.bull - range.base >= gap) pieces.push(tag('lower', 'High', range.bull));
  if (price != null) pieces.push(part('mark needle', price), tag('upper', 'Share price', price, money));
  scale.replaceChildren(...pieces);

  scale.setAttribute('aria-label', `Fair value ${whole(range.base)}, with a range from ${whole(range.bear)} to ${whole(range.bull)}${price != null ? `. The share price is ${money(price)}.` : '.'}`);
}

function headline(a, range, price) {
  const name = displayName(a);
  if (range.base <= 0) {
    return { title: `${name} shows no value left for shareholders on these assumptions`, sub: `Debts are larger than the business value in this estimate. The range is ${whole(range.bear)} to ${whole(range.bull)}.` };
  }
  const title = `${name} looks worth about ${whole(range.base)} a share`;
  const rangeText = `The low to high range is ${whole(range.bear)} to ${whole(range.bull)}.`;
  if (price == null) return { title, sub: `${rangeText} The live share price could not be loaded.` };
  const gap = Math.abs(price / range.base - 1);
  let position;
  if (price > range.bull) position = `At ${money(price)}, the share price is above that range, ${percent(gap, 0)} over the central estimate.`;
  else if (price < range.bear) position = `At ${money(price)}, the share price is below that range, ${percent(gap, 0)} under the central estimate.`;
  else position = `At ${money(price)}, the share price is inside that range.`;
  return { title, sub: `${rangeText} ${position}` };
}

function impliedText(a, assumptions) {
  const { price } = a.market;
  const implied = impliedByPrice(a.valuation, assumptions, price);
  if (!implied) return '';
  if (a.valuation.kind === 'dcf') {
    if (implied.outOfRange === 'above') return 'The share price needs more growth than this model can reach, even starting at 100% a year.';
    if (implied.outOfRange === 'below') return 'The share price is low enough that it assumes the business shrinks heavily for years.';
    return `On the cash flow forecast alone, ${money(price)} needs revenue and profit to grow about ${percent(implied.averageGrowth, 0)} a year on average for 10 years, starting at ${percent(implied.value, 0)}.`;
  }
  if (implied.outOfRange === 'above') return 'The share price needs a higher return on equity than this model can reach.';
  if (implied.outOfRange === 'below') return 'The share price assumes returns far below normal, held for good.';
  return `To justify ${money(price)}, the company would need to hold a return on equity of about ${percent(implied.value, 0)} for good. Today's default is ${percent(assumptions.roe, 0)}.`;
}

function renderMethods(a, range) {
  const models = a.valuation.fixed.marketModels ?? [];
  const forecastLabel = a.valuation.kind === 'dcf' ? 'Cash flow forecast' : 'Book value and returns';
  const rows = [
    { label: forecastLabel, value: range.model, detail: models.length ? `${Math.round(FORECAST_WEIGHT * 100)}% of the fair value` : 'The only model available' },
    ...models,
  ];
  $('methods-note').textContent = models.length >= 5
    ? `The other ${models.length} models make up ${Math.round((1 - FORECAST_WEIGHT) * 100)}%. They are averaged after dropping the highest and lowest.`
    : models.length ? `The other ${models.length === 1 ? 'model makes' : `${models.length} models make`} up ${Math.round((1 - FORECAST_WEIGHT) * 100)}%.` : '';
  $('methods').replaceChildren(...rows.map(method => {
    const group = document.createElement('div');
    const term = document.createElement('dt');
    term.textContent = method.label;
    const detail = document.createElement('dd');
    const figure = document.createElement('span');
    figure.className = 'figure';
    figure.textContent = whole(Math.max(method.value, 0));
    const note = document.createElement('span');
    note.className = 'note';
    note.textContent = method.detail;
    detail.append(figure, note);
    group.append(term, detail);
    return group;
  }));
}

function refresh() {
  const { analysis: a, assumptions } = state;
  const range = valueRange(a.valuation, assumptions);
  const { title, sub } = headline(a, range, a.market.price);
  $('headline').textContent = title;
  $('subline').textContent = sub;
  renderScale(range, a.market.price);
  $('implied').textContent = impliedText(a, assumptions);
  renderMethods(a, range);
  const defaults = a.valuation.assumptions;
  $('reset').disabled = Object.keys(defaults).every(key => defaults[key] === assumptions[key]);
}

function renderSliders() {
  const { analysis: a, assumptions } = state;
  const holder = $('sliders');
  holder.replaceChildren(...a.valuation.sliders.map(spec => {
    const box = document.createElement('div');
    box.className = 'slider';
    const label = document.createElement('label');
    label.htmlFor = `slider-${spec.key}`;
    const name = document.createElement('span');
    name.textContent = spec.label;
    const output = document.createElement('output');
    output.htmlFor = `slider-${spec.key}`;
    label.append(name, output);
    const range = document.createElement('input');
    range.type = 'range';
    range.id = `slider-${spec.key}`;
    range.min = spec.min;
    range.max = spec.max;
    range.step = spec.step;
    range.value = assumptions[spec.key];
    const show = () => {
      output.textContent = percent(assumptions[spec.key], 1);
      range.setAttribute('aria-valuetext', percent(assumptions[spec.key], 1));
    };
    show();
    range.addEventListener('input', () => {
      assumptions[spec.key] = Number(range.value);
      show();
      refresh();
    });
    const help = document.createElement('p');
    help.className = 'help';
    help.textContent = spec.help;
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = a.valuation.explain[spec.key];
    box.append(label, range, help, why);
    return box;
  }));
}

function fillList(element, items) {
  element.replaceChildren(...items.map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
}

function renderHistory(a) {
  const { annual, ttm, balance, shares } = a.co;
  const fcf = row => (row.ocf != null && row.capex != null ? row.ocf - row.capex - (row.sbc ?? 0) : null);
  const rows = [...annual].map(row => [row.end.slice(0, 7), row.revenue, row.opIncome, row.netIncome, fcf(row)]);
  if (ttm.isTrailing) rows.push([`12 months to ${ttm.end.slice(0, 7)}`, ttm.revenue, ttm.opIncome, ttm.netIncome, fcf(ttm)]);
  const head = document.createElement('thead');
  const headRow = head.insertRow();
  for (const text of ['Period', 'Revenue', 'Operating profit', 'Net profit', 'Free cash flow']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    headRow.append(cell);
  }
  const body = document.createElement('tbody');
  for (const [period, ...values] of rows) {
    const row = body.insertRow();
    row.insertCell().textContent = period;
    for (const value of values) row.insertCell().textContent = billions(value);
  }
  $('history').replaceChildren(head, body);
  const parts = [`Free cash flow here is after share-based pay.`];
  if (balance.asOf) parts.push(`Balance sheet from ${balance.asOf}: cash ${billions(balance.cash)}, debt ${billions(balance.debt)}.`);
  if (shares) parts.push(`Shares: ${(shares.val / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} million, from the ${shares.source}.`);
  if (a.valuation?.meta?.cost && !a.valuation.meta.cost.riskFreeLive) parts.push('The live Treasury yield was unavailable, so 4.2% was used.');
  $('sources').textContent = parts.join(' ');
}

function render() {
  const { analysis: a, row } = state;
  const nextEarnings = a.market.nextEarnings ? ` Next earnings ${new Date(a.market.nextEarnings).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}.` : '';
  const priceDate = a.market.today ? new Date(a.market.today).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' }) : null;
  $('company').textContent = `${row.ticker}, ${a.label.toLowerCase()}${a.co.sicDescription ? `, ${a.co.sicDescription.toLowerCase()}` : ''}.${priceDate ? ` Price from ${priceDate}.` : ''}${nextEarnings}`;
  loadScreener().then(rows => { if (state?.analysis === a) renderCompanyData(a, rows); });
  renderCompanyData(a);
  renderHistory(a);

  const hasValue = a.fairValueAvailable;
  $('scale').hidden = !hasValue;
  $('tinker').hidden = !hasValue;
  $('trust').hidden = !hasValue;
  $('implied').hidden = !hasValue;
  $('methods-section').hidden = !hasValue;

  if (hasValue) {
    $('confidence').replaceChildren();
    const level = document.createElement('strong');
    level.textContent = `${a.confidence.level} confidence.`;
    $('confidence').append(level, ` Valued as a ${a.label.toLowerCase()} using ${(a.valuation.fixed.marketModels?.length ?? 0) + 1} valuation models. This rates how well the method fits the company, not whether the value is right.`);
    fillList($('reasons'), a.confidence.reasons);
    fillList($('warnings'), a.warnings);
    renderSliders();
    refresh();
  } else {
    $('headline').textContent = `No reliable fair value for ${displayName(a)}`;
    $('subline').textContent = a.reason;
  }
  $('result').hidden = false;
}

input.addEventListener('input', suggest);
input.addEventListener('blur', () => setTimeout(closeList, 100));
input.addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!matches.length) return;
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex = (activeIndex + step + matches.length) % matches.length;
    renderList();
  } else if (event.key === 'Escape') {
    closeList();
  }
});

$('search').addEventListener('submit', event => {
  event.preventDefault();
  if (activeIndex >= 0 && matches[activeIndex]) choose(matches[activeIndex]);
  else submit(input.value);
});

$('examples').addEventListener('click', event => {
  const ticker = event.target.closest('button')?.dataset.ticker;
  if (ticker) { input.value = ticker; submit(ticker); }
});

$('reset').addEventListener('click', () => {
  state.assumptions = { ...state.analysis.valuation.assumptions };
  renderSliders();
  refresh();
  $('slider-' + state.analysis.valuation.sliders[0].key).focus();
});

const params = new URL(location.href).searchParams;
const start = params.get('t');
const screening = params.get('view') === 'screener';
$(screening ? 'nav-screen' : 'nav-value').setAttribute('aria-current', 'page');
if (screening) {
  $('search').hidden = true;
  $('screener').hidden = false;
  document.title = 'Stock Screener';
  initScreener();
} else if (start) {
  input.value = start;
  sizeInput();
  submit(start);
}
