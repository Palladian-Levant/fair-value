# Fair Value

Estimates what the largest US companies are worth from their SEC filings. Each company
gets assumptions set for it, and you can change them with sliders. A screener ranks
companies by the gap between fair value and share price, by sector.

This is a research tool, not financial advice.

## How it works

GitHub runs `scripts/build-screener.mjs` after each US trading day, for free. It values
up to 500 of the largest companies and saves the results in `docs/data/`. The website on
GitHub Pages reads those files, so it needs no server and no laptop running. A full run
takes about 45 minutes because of the free Finnhub limit. If a run goes badly, the earlier
results stay in place.

Data comes from SEC EDGAR, Finnhub (share prices and risk data) and the US Treasury
(bond yields). The Finnhub key and contact email are stored as GitHub repository secrets.

## How companies are valued

Fair value combines several models. The cash flow forecast counts for 35%, or book value
and returns for banks and insurers. The rest is the average of market models, after
dropping the highest and lowest:

- The company's usual P/E, EV/EBITDA and P/S, or P/B for banks and insurers
- The typical P/E and EV/EBITDA in its sector, or P/B for banks and insurers

Earnings use normal and analyst-expected figures together, and growth blends past results
with analyst expectations worked out from forward P/E and PEG. Companies are sorted into a
type first:

| Type | Method | Defaults |
|---|---|---|
| Steady | 10-year discounted cash flow | Growth 1–10%, middle operating margin of recent years |
| Fast grower | Same, with growth fading harder | Growth 5–25%, recent margins, wider range |
| Cyclical | Same, using mid-cycle figures | Growth 0–4%, average margin across good and bad years |
| Bank or insurer | Book value plus future excess returns | Return on equity from the last 5 years |
| Loss-making or shell | None | No fair value is shown |

- The starting point is operating profit, which leaves out investment gains and already
  counts share-based pay as a cost.
- Each year's cash is profit after tax, less the reinvestment needed to pay for that
  year's growth, based on the company's return on capital.
- The discount rate uses the 10-year Treasury yield, a 4.5% equity risk premium, the
  company's beta and its cost of debt, held within 8–12%.
- Growth fades to 3% by year 10.
- The confidence rating shows how well the method fits the company. It does not say
  whether the value is right.

## Limits

- It covers only large companies that report to the SEC in US dollars.
- Prices are from the last nightly update, not live.
- The biggest gaps are often companies in trouble, or cases the model handles badly.
- Sectors come from SEC industry codes, so a few companies may sit in a surprising group.
- Forecasts come from past results, so they can miss a major change in a business.
- Discounted cash flows are often harsh on high-quality companies, so a value below the
  share price is not by itself a reason to sell.
- Property trusts and companies with finance arms fit the model poorly, and the page warns
  about both.

## Tests

```
npm test
node tests/browser-check.mjs <folder for screenshots>
```

The browser check needs Playwright. Test data is described at the top of `tests/fixtures.mjs`.
