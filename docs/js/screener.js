// The screener page. Results are built overnight, so filtering here is instant.
import { SECTORS } from './sectors.js';

const $ = id => document.getElementById(id);
const CONFIDENCE = { Low: 0, Medium: 1, High: 2 };
const PAGE = 50;
const MS_PER_DAY = 864e5;

const NUMERIC = {
  gap: row => row.gap,
  price: row => row.price,
  fair: row => row.fair,
  confidence: row => row.score,
  cap: row => row.cap,
};

export function filterRows(rows, { sector = 'all', minConfidence = 'Medium', minCap = 0 } = {}) {
  return rows.filter(row => (sector === 'all' || row.sector === sector)
    && CONFIDENCE[row.confidence] >= CONFIDENCE[minConfidence]
    && row.cap >= minCap);
}

export function sortRows(rows, key = 'gap', direction = 'desc') {
  const value = NUMERIC[key] ?? NUMERIC.gap;
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => sign * (value(a) - value(b)) || a.ticker.localeCompare(b.ticker));
}

export function daysOld(generatedAt, now = Date.now()) {
  return Math.floor((now - Date.parse(generatedAt)) / MS_PER_DAY);
}

const money = value => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = value => `$${Math.round(value).toLocaleString('en-US')}`;
const signed = value => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(0)}%`;
const size = cap => (cap >= 1e12 ? `$${(cap / 1e12).toFixed(1)}tn` : `$${(cap / 1e9).toFixed(0)}bn`);

function cell(row, label, ...children) {
  const element = row.insertCell();
  element.dataset.label = label;
  element.append(...children);
  return element;
}

function small(text, className = 'detail') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function fitSelect(select) {
  const ruler = $('sector-ruler');
  ruler.textContent = select.options[select.selectedIndex].text;
  const { fontSize } = getComputedStyle(ruler);
  select.style.width = `${ruler.getBoundingClientRect().width + 0.62 * parseFloat(fontSize)}px`;
}

export async function initScreener() {
  const filters = { sector: 'all', minConfidence: 'Medium', minCap: 0 };
  const params = new URL(location.href).searchParams;
  const sector = $('sector');
  const confidence = $('min-confidence');
  const cap = $('min-cap');
  let sortKey = 'gap';
  let direction = 'desc';
  let shown = PAGE;
  let data = null;

  sector.append(...SECTORS.map(name => new Option(name, name)));
  if (SECTORS.includes(params.get('sector'))) {
    filters.sector = params.get('sector');
    sector.value = filters.sector;
  }
  fitSelect(sector);
  document.fonts?.ready.then(() => fitSelect(sector));

  function render() {
    const matching = sortRows(filterRows(data.rows, filters), sortKey, direction);
    const missing = filters.sector === 'all'
      ? Object.values(data.notValued ?? {}).reduce((sum, count) => sum + count, 0)
      : data.notValued?.[filters.sector] ?? 0;
    const hiddenLow = filterRows(data.rows, { ...filters, minConfidence: 'Low' }).length - matching.length;

    const notes = [`${matching.length} ${matching.length === 1 ? 'company matches' : 'companies match'}.`];
    if (hiddenLow > 0 && filters.minConfidence !== 'Low') notes.push(`${hiddenLow} lower-confidence ${hiddenLow === 1 ? 'result is' : 'results are'} hidden.`);
    if (missing) notes.push(`${missing} could not be valued.`);
    $('screen-count').textContent = notes.join(' ');

    const gaps = matching.map(row => row.gap).sort((a, b) => a - b);
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    $('screen-typical').textContent = gaps.length >= 5 && typical < -0.15
      ? `The typical company here has a fair value ${Math.abs(typical * 100).toFixed(0)}% below its share price. These defaults are strict, so compare companies with each other rather than reading one gap alone.`
      : '';

    const body = document.createElement('tbody');
    for (const item of matching.slice(0, shown)) {
      const row = body.insertRow();
      const link = document.createElement('a');
      link.href = `./?t=${encodeURIComponent(item.ticker)}`;
      link.textContent = item.name;
      const context = `${item.ticker}, ${size(item.cap)}${filters.sector === 'all' ? `, ${item.sector}` : ''}`;
      cell(row, 'Company', link, small(context));
      cell(row, 'Price', money(item.price));
      cell(row, 'Fair value', whole(item.fair), small(`${whole(item.low)} to ${whole(item.high)}`));
      const gap = cell(row, 'Gap', small(signed(item.gap), 'gap'));
      if (item.price < item.low) gap.append(small('Below low estimate'));
      const trust = cell(row, 'Confidence', item.confidence, small(item.label));
      for (const flag of item.flags) trust.append(small(flag, 'flag'));
    }
    $('screen-table').querySelector('tbody')?.remove();
    $('screen-table').append(body);
    $('screen-table').hidden = !matching.length;
    $('screen-empty').hidden = matching.length > 0;
    $('show-more').hidden = shown >= matching.length;

    for (const header of document.querySelectorAll('#screen-table th[data-sort]')) {
      const active = header.dataset.sort === sortKey;
      if (active) header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
      else header.removeAttribute('aria-sort');
    }
  }

  function changed() {
    shown = PAGE;
    filters.sector = sector.value;
    filters.minConfidence = confidence.value;
    filters.minCap = Number(cap.value);
    fitSelect(sector);
    const url = new URL(location.href);
    if (filters.sector === 'all') url.searchParams.delete('sector');
    else url.searchParams.set('sector', filters.sector);
    history.replaceState(null, '', url);
    if (data) render();
  }

  for (const control of [sector, confidence, cap]) control.addEventListener('change', changed);

  $('screen-table').addEventListener('click', event => {
    const button = event.target.closest('th[data-sort] button');
    if (!button) return;
    const { sort } = button.parentElement.dataset;
    if (sort === sortKey) direction = direction === 'desc' ? 'asc' : 'desc';
    else { sortKey = sort; direction = 'desc'; }
    render();
  });

  $('show-more').addEventListener('click', () => { shown += PAGE; render(); });

  try {
    const response = await fetch('data/screener.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('missing');
    data = await response.json();
    if (!Array.isArray(data.rows)) throw new Error('invalid');
  } catch {
    $('screen-status').textContent = 'The first overnight update has not finished yet. Check back soon.';
    $('screen-status').dataset.kind = 'error';
    $('screen-status').hidden = false;
    return;
  }

  const age = daysOld(data.generatedAt);
  const date = new Date(data.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('screen-age').textContent = `${data.rows.length} of the largest US companies, using prices from ${date}.`;
  if (age > 4) {
    $('screen-status').textContent = `These results are ${age} days old, so the nightly update may have stopped. Check the Actions tab on GitHub.`;
    $('screen-status').dataset.kind = 'error';
    $('screen-status').hidden = false;
  }
  $('screen-results').hidden = false;
  render();
}
