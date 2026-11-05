// Runs the real page in a browser with simulated data sources.
// Usage: node tests/browser-check.mjs <folder for screenshots>
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { extractCompany } from '../docs/js/extract.js';
import { COMPANIES } from './fixtures.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const shots = process.argv[2] ?? '.';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const file = pathname === '/' ? '/index.html' : pathname;
  try {
    const body = await readFile(path.join(root, file));
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise(resolve => server.listen(8123, resolve));
const site = 'http://localhost:8123/';

function companyData({ sparse = false } = {}) {
  const companies = {};
  for (const c of Object.values(COMPANIES)) {
    const co = extractCompany(c.facts, { sic: c.sic, sicDescription: c.sicDescription });
    const market = sparse ? { today: '2026-11-05' } : {
      price: c.price, beta: c.beta, week52High: c.price * 1.15, week52Low: c.price * 0.8,
      peHistory: [24, 22, 25], companyName: c.displayName, riskFree: 0.041, today: '2026-11-05',
    };
    companies[c.ticker] = JSON.parse(JSON.stringify({ co, market }));
  }
  return { generatedAt: new Date().toISOString(), companies };
}

async function prepare(page, { sparse = false, broken = false, screener = 'ok', missing = false } = {}) {
  await page.route('**/data/companies.json', route => {
    if (missing) return route.fulfill({ status: 404, body: 'none' });
    if (broken) return route.fulfill({ status: 500, body: 'error' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(companyData({ sparse })) });
  });
  await page.route('**/data/screener.json', route => {
    if (screener === 'missing') return route.fulfill({ status: 404, body: 'none' });
    const age = screener === 'old' ? 9 : 0;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(screenData(age)) });
  });
}

function screenData(daysOld) {
  const rows = [
    ['XOM', 'Exxon Mobil', 'Energy', 'Cyclical company', 112.4, 151, 118, 186, 'Medium', 55, 480e9, []],
    ['CVX', 'Chevron', 'Energy', 'Cyclical company', 158.2, 172, 131, 210, 'Medium', 50, 280e9, []],
    ['HAL', 'Halliburton', 'Energy', 'Cyclical company', 28.1, 74, 55, 96, 'Low', 25, 25e9, ['Unusually large gap']],
    ['KO', 'Coca-Cola', 'Consumer staples', 'Steady company', 82.62, 51, 42, 63, 'High', 85, 355e9, []],
    ['PEP', 'PepsiCo', 'Consumer staples', 'Steady company', 141.5, 158, 131, 188, 'High', 85, 193e9, []],
    ['NVDA', 'NVIDIA', 'Technology', 'Fast grower', 205.19, 124, 82, 181, 'Medium', 60, 4.98e12, []],
    ['MSFT', 'Microsoft', 'Technology', 'Fast grower', 480.1, 421, 301, 590, 'Medium', 65, 3.56e12, []],
    ['JPM', 'JPMorgan Chase', 'Financials', 'Bank or insurer', 320.72, 246, 214, 277, 'Medium', 65, 852e9, []],
    ['F', 'Ford Motor', 'Consumer discretionary', 'Cyclical company', 13.5, 18, 9, 27, 'Low', 10, 54e9, ['Recent loss']],
  ].map(([ticker, name, sector, label, price, fair, low, high, confidence, score, cap, flags]) => ({
    ticker, name, sector, label, price, fair, low, high, confidence, score, cap, flags, gap: fair / price - 1,
  }));
  return { generatedAt: new Date(Date.now() - daysOld * 864e5).toISOString(), attempted: 600, failed: 3, notValued: { Energy: 2, Technology: 8 }, rows };
}

const problems = [];
function watch(page) {
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !/status of (404|50\d)/.test(message.text())) problems.push(`console: ${message.text()}`);
  });
}

async function search(page, text) {
  await page.fill('#ticker', text);
  await page.keyboard.press('Enter');
}

const browser = await chromium.launch();
const results = [];
const check = async (name, work) => {
  await work();
  results.push(name);
  console.log('ok -', name);
};

const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
const page = await desktop.newPage();
watch(page);
await prepare(page);

await check('first screen', async () => {
  await page.goto(site);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: `${shots}/1-start.png` });
});

await check('search by company name, with suggestions', async () => {
  await page.click('#ticker');
  await page.keyboard.type('coca');
  await page.waitForSelector('#suggestions li');
  assert.match(await page.textContent('#suggestions li'), /KO/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.textContent('#headline'), /Coca-Cola looks worth about \$\d+ a share/);
  assert.match(new URL(page.url()).search, /t=KO/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/2-result-coca-cola.png`, fullPage: true });
});

await check('sliders update the value at once, and reset restores it', async () => {
  const before = await page.textContent('#headline');
  await page.locator('#slider-growth').fill('0.1');
  const after = await page.textContent('#headline');
  assert.notEqual(before, after);
  assert.equal(await page.isDisabled('#reset'), false);
  await page.click('#reset');
  assert.equal(await page.textContent('#headline'), before);
  assert.equal(await page.isDisabled('#reset'), true);
});

for (const [ticker, pattern, file] of [
  ['NVDA', /Nvidia looks worth/, '3-nvidia'],
  ['F', /Ford Motor looks worth/, '4-ford'],
  ['JPM', /JPMorgan Chase looks worth/, '5-jpmorgan'],
]) {
  await check(`${ticker} result`, async () => {
    await search(page, ticker);
    await page.waitForFunction(p => new RegExp(p, 'i').test(document.getElementById('headline').textContent) && !document.getElementById('result').hidden, pattern.source);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${shots}/${file}.png`, fullPage: true });
    assert.ok((await page.textContent('#company')).includes(ticker));
  });
}

await check('the bank shows bank assumptions and a held-return message', async () => {
  assert.ok(await page.isVisible('#slider-roe'));
  assert.match(await page.textContent('#methods'), /Book value and returns/);
  assert.match(await page.textContent('#implied'), /return on equity/);
});

await check('loss-making company gets no made-up number', async () => {
  await search(page, 'LOSS');
  await page.waitForFunction(() => /No reliable fair value/.test(document.getElementById('headline').textContent));
  assert.equal(await page.isVisible('#tinker'), false);
  assert.equal(await page.isVisible('#scale'), false);
  await page.screenshot({ path: `${shots}/6-loss-making.png`, fullPage: true });
});

await check('a company outside the list explains why', async () => {
  await search(page, 'ZZZZZZ');
  await page.waitForFunction(() => /is not in the list/.test(document.getElementById('status').textContent));
});

await check('page reloads from a shared link', async () => {
  await page.goto(`${site}?t=KO`);
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.textContent('#headline'), /Coca-Cola/);
});

await check('value still shows if market data is missing', async () => {
  const p = await desktop.newPage();
  watch(p);
  await prepare(p, { sparse: true });
  await p.goto(`${site}?t=KO`);
  await p.waitForSelector('#result:not([hidden])');
  assert.match(await p.textContent('#subline'), /share price could not be loaded/);
  assert.match(await p.textContent('#reasons'), /market-average/);
  await p.click('summary');
  assert.match(await p.textContent('#sources'), /4\.2%/);
  await p.close();
});

await check('a failed data file gives a clear message', async () => {
  const p = await desktop.newPage();
  watch(p);
  await prepare(p, { broken: true });
  await p.goto(site);
  await search(p, 'KO');
  await p.waitForFunction(() => /could not be loaded/.test(document.getElementById('status').textContent));
  await p.close();
});

await check('before the first update, the page says so', async () => {
  const p = await desktop.newPage();
  watch(p);
  await prepare(p, { missing: true });
  await p.goto(site);
  await search(p, 'KO');
  await p.waitForFunction(() => /first update has not finished/.test(document.getElementById('status').textContent));
  await p.close();
});

await check('the result shows the date of its price', async () => {
  await page.goto(`${site}?t=KO`);
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.textContent('#company'), /Price from 5 November/);
  assert.match(await page.textContent('#methods'), /Cash flow forecast/);
  assert.match(await page.textContent('#methods'), /usual price to earnings/);
  const forecast = await page.textContent('#methods div:first-child .figure');
  await page.locator('#slider-growth').fill('0.15');
  assert.notEqual(await page.textContent('#methods div:first-child .figure'), forecast);
});

await check('screener ranks the biggest gap first and links to the full valuation', async () => {
  await page.goto(`${site}?view=screener`);
  await page.waitForSelector('#screen-results:not([hidden])');
  await page.waitForTimeout(50);
  const first = await page.textContent('#screen-table tbody tr:first-child td:first-child');
  assert.match(first, /Exxon/);
  assert.match(await page.textContent('#screen-count'), /7 companies match. 2 lower-confidence results are hidden. 10 could not be valued/);
  assert.equal(await page.isVisible('#search'), false);
  assert.equal(await page.textContent('#screen-typical'), '');
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/10-screener.png`, fullPage: true });
  await page.click('#screen-table a:has-text("Coca-Cola")');
  await page.waitForSelector('#result:not([hidden])');
  assert.match(page.url(), /\?t=/);
});

await check('screener filters by sector and confidence, and keeps the sector in the link', async () => {
  await page.goto(`${site}?view=screener`);
  await page.waitForSelector('#screen-results:not([hidden])');
  await page.selectOption('#sector', 'Energy');
  assert.match(page.url(), /sector=Energy/);
  assert.equal(await page.locator('#screen-table tbody tr').count(), 2);
  await page.selectOption('#min-confidence', 'Low');
  assert.equal(await page.locator('#screen-table tbody tr').count(), 3);
  assert.match(await page.textContent('#screen-table tbody tr:first-child'), /Unusually large gap/);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${shots}/11-screener-energy.png`, fullPage: true });
  await page.selectOption('#min-cap', '200000000000');
  assert.equal(await page.locator('#screen-table tbody tr').count(), 2);
  await page.selectOption('#sector', 'Utilities');
  assert.equal(await page.isVisible('#screen-empty'), true);
  await page.goto(`${site}?view=screener&sector=Technology`);
  await page.waitForSelector('#screen-results:not([hidden])');
  assert.equal(await page.inputValue('#sector'), 'Technology');
  assert.equal(await page.locator('#screen-table tbody tr').count(), 2);
});

await check('screener columns sort both ways', async () => {
  await page.goto(`${site}?view=screener`);
  await page.waitForSelector('#screen-results:not([hidden])');
  await page.click('th[data-sort="confidence"] button');
  assert.match(await page.textContent('#screen-table tbody tr:first-child'), /Coca-Cola|PepsiCo/);
  await page.click('th[data-sort="gap"] button');
  await page.click('th[data-sort="gap"] button');
  assert.match(await page.textContent('#screen-table tbody tr:first-child'), /NVIDIA/);
  assert.equal(await page.getAttribute('th[data-sort="gap"]', 'aria-sort'), 'ascending');
});

await check('screener explains missing or old results', async () => {
  const missing = await desktop.newPage();
  watch(missing);
  await prepare(missing, { screener: 'missing' });
  await missing.goto(`${site}?view=screener`);
  await missing.waitForFunction(() => /first overnight update/.test(document.getElementById('screen-status').textContent));
  await missing.close();
  const old = await desktop.newPage();
  watch(old);
  await prepare(old, { screener: 'old' });
  await old.goto(`${site}?view=screener`);
  await old.waitForFunction(() => /9 days old/.test(document.getElementById('screen-status').textContent));
  await old.close();
});

await check('phone layout has no sideways scrolling', async () => {
  const phone = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 360, height: 780 } });
  const p = await phone.newPage();
  watch(p);
  await prepare(p);
  for (const ticker of ['KO', 'NVDA', 'JPM']) {
    await p.goto(`${site}?t=${ticker}`);
    await p.waitForSelector('#result:not([hidden])');
    await p.waitForTimeout(200);
    const widths = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
    assert.ok(widths[0] <= widths[1], `${ticker} ${widths}`);
  }
  await p.goto(`${site}?t=KO`);
  await p.waitForSelector('#result:not([hidden])');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${shots}/7-phone.png`, fullPage: true });
  await p.goto(`${site}?view=screener`);
  await p.waitForSelector('#screen-results:not([hidden])');
  await p.waitForTimeout(200);
  const screenWidths = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  assert.ok(screenWidths[0] <= screenWidths[1], `screener ${screenWidths}`);
  await p.screenshot({ path: `${shots}/12-screener-phone.png`, fullPage: true });
  await phone.close();
});

await check('dark mode', async () => {
  const dark = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
  const p = await dark.newPage();
  watch(p);
  await prepare(p);
  await p.goto(`${site}?t=NVDA`);
  await p.waitForSelector('#result:not([hidden])');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${shots}/8-dark.png`, fullPage: true });
  await p.goto(`${site}?view=screener&sector=Energy`);
  await p.waitForSelector('#screen-results:not([hidden])');
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${shots}/13-screener-dark.png`, fullPage: true });
  await dark.close();
});

await browser.close();
server.close();
assert.deepEqual(problems, []);
console.log(`${results.length} browser checks passed, no page errors`);
