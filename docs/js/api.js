// Loads the results saved by the nightly update.

let companiesRequest;

export function loadCompanies() {
  companiesRequest ??= fetch('data/companies.json', { cache: 'no-cache' }).then(async response => {
    if (!response.ok) {
      const error = new Error('The data could not be loaded.');
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    return {
      ...data,
      list: Object.entries(data.companies).map(([ticker, entry]) => ({
        ticker,
        title: entry.market.companyName || entry.co.name,
      })),
    };
  }).catch(error => { companiesRequest = undefined; throw error; });
  return companiesRequest;
}

export function searchTickers(list, text, limit = 6) {
  const query = text.trim().toUpperCase();
  if (!query) return [];
  const score = row => {
    if (row.ticker === query) return 0;
    if (row.ticker.startsWith(query)) return 1;
    if (row.title.toUpperCase().startsWith(query)) return 2;
    if (query.length >= 3 && row.title.toUpperCase().includes(query)) return 3;
    return 9;
  };
  return list.map(row => [score(row), row]).filter(([s]) => s < 9)
    .sort((a, b) => a[0] - b[0] || a[1].ticker.length - b[1].ticker.length)
    .slice(0, limit).map(([, row]) => row);
}
