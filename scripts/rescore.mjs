// Recalculates the screener from saved company data, without fetching anything.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreCompanies } from './build-screener.mjs';

const folder = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'data');
const companiesPath = path.join(folder, 'companies.json');
const screenerPath = path.join(folder, 'screener.json');

const saved = JSON.parse(await readFile(companiesPath, 'utf8'));
const screener = JSON.parse(await readFile(screenerPath, 'utf8'));
const scored = scoreCompanies(saved.companies);
await writeFile(companiesPath, JSON.stringify(saved));
await writeFile(screenerPath, JSON.stringify({ ...screener, ...scored }));
console.log(`Rescored ${scored.rows.length} companies.`);
