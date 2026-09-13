# Company watchlist expansion research

Research date: 2026-09-10

## Goal

Expand the company catalogue from 14 user-selected companies by identifying five close peers for
each seed company. Similarity is based on product category, buyer, regulated workflow, data or
engineering problem, and practical relevance to backend/data roles. A repeated recommendation is
stored once in the catalogue even when it is relevant to several seeds.

The result is 70 seed-to-peer relationships covering 68 unique companies: 14 seed companies and
54 unique peer companies. All 68 have been added to `portals.yml`. Twenty-eight have a supported,
verified ATS source. A follow-up source audit on 2026-09-12 activated another 14 server-rendered
official career pages through the bounded `official-html` adapter. Remaining sources stay paused
when they are blocked, client-rendered, empty, redirected, or structurally ambiguous. A second
source-resolution audit on 2026-09-13 replaced ten stale/general URLs with verified Ashby,
Greenhouse, or Comeet boards and activated SuperPlay through `official-html`. The current catalogue
therefore has 69 active sources and 22 saved for later adapter work.

## Recommendation map

| Seed company | Primary category | Five close peers |
| --- | --- | --- |
| Finubit | Cloud-native core banking | ONE ZERO Bank, AccessFintech, OpenLegacy, Personetics, Earnix |
| Appcharge | DTC commerce and payments for mobile games | Overwolf, Moon Active, Playtika, Plarium, SuperPlay |
| Unipaas | Embedded payments for vertical SaaS | Rapyd, Unit, Nayax, BlueSnap, Payoneer |
| FINQ | AI investment and pension technology | Pagaya, eToro, FundGuard, Pontera, RiseUp |
| PayEm | Spend and procurement automation | Mesh Payments, Tipalti, Melio, Stampli, Payoneer |
| Neema | Cross-border consumer payments | Payoneer, Rapyd, Okoora, Airwallex, Wise |
| IVIX | AI and data for financial-crime and tax authorities | ThetaRay, Chainalysis, TRM Labs, Unit21, ComplyAdvantage |
| PayKey | Embedded banking engagement | Personetics, ONE ZERO Bank, Unit, Rapyd, Amount |
| Voyantis | AI decisioning and predictive customer value | Optimove, AppsFlyer, Singular, Similarweb, Dynamic Yield |
| Forter | Ecommerce identity and fraud prevention | Riskified, Signifyd, Sift, BioCatch, Chargeflow |
| Gong | Revenue intelligence and sales execution | ZoomInfo, Outreach, Salesloft, DealHub, Lusha |
| Okoora | FX and cross-border financial infrastructure | Airwallex, Rapyd, Payoneer, Kantox, Currencycloud |
| Monto | B2B collections and accounts receivable | Melio, Tipalti, Stampli, Balance, Finaloop |
| Hypernative | Real-time Web3 threat prevention | Fireblocks, Blockaid, Chainalysis, TRM Labs, Cyvers |

## Why the recommendations are useful

The map intentionally mixes three kinds of similarity:

1. **Direct competitors**, such as Forter, Riskified, Signifyd, and Sift.
2. **Adjacent infrastructure**, such as Unipaas, Rapyd, Unit, and Payoneer, where the same backend
   and payments experience transfers even when the buyer or distribution model differs.
3. **Companies solving the same data problem in another workflow**, such as IVIX, Chainalysis, TRM
   Labs, and ThetaRay, or Voyantis, Optimove, AppsFlyer, and Singular.

The list favors companies with Israeli headquarters, Israeli R&D, or a plausible Israel/remote
engineering route. A few global peers remain because they define the category and may expose remote
roles. The existing location filter is still authoritative, so a supported global board cannot
surface a blocked US-only role as a match.

## Newly activated ATS sources

These sources were checked directly and use one of the adapters already implemented by jobOps.

| Company | Provider | Verified career source | Notes |
| --- | --- | --- | --- |
| Moon Active | Ashby | [jobs.ashbyhq.com/moonactive](https://jobs.ashbyhq.com/moonactive) | Active board with Israel roles |
| Unit | Ashby | [jobs.ashbyhq.com/unit](https://jobs.ashbyhq.com/unit) | Active board; location filtering remains in force |
| Pontera | Greenhouse | [job-boards.greenhouse.io/pontera](https://job-boards.greenhouse.io/pontera) | Public Greenhouse API returned jobs |
| Chainalysis | Ashby | [jobs.ashbyhq.com/chainalysis-careers](https://jobs.ashbyhq.com/chainalysis-careers) | Active board, including Tel Aviv roles |
| Amount | Greenhouse | [job-boards.greenhouse.io/amount](https://job-boards.greenhouse.io/amount) | Public Greenhouse API returned jobs |
| Singular | Ashby | [jobs.ashbyhq.com/singular](https://jobs.ashbyhq.com/singular) | Active board with Tel Aviv presence |
| Sift | Ashby | [jobs.ashbyhq.com/sift](https://jobs.ashbyhq.com/sift) | Active fraud-tech board |
| BioCatch | Lever | [jobs.lever.co/biocatch](https://jobs.lever.co/biocatch) | Active Tel Aviv backend and data roles were visible |
| Outreach | Lever | [jobs.lever.co/outreach](https://jobs.lever.co/outreach) | Active board; location filtering remains in force |
| Salesloft | Greenhouse | [job-boards.greenhouse.io/salesloft](https://job-boards.greenhouse.io/salesloft) | Public Greenhouse API returned jobs |
| Kantox | Workable | [apply.workable.com/kantox](https://apply.workable.com/kantox) | Active Workable board |

Existing supported sources in the 68-company research set remain active: Gong, Forter, Payoneer,
Pagaya, Melio, AppsFlyer, Similarweb, Riskified, and Fireblocks.

### Sources recovered by exact ATS discovery on 2026-09-13

The previous audit had saved a company careers page or an obsolete board. Opening those pages and
identifying the provider behind them recovered the following existing-adapter sources:

| Company | Provider | Verified career source | Jobs returned during probe |
| --- | --- | --- | ---: |
| Payzen | Ashby | [jobs.ashbyhq.com/payzen-inc](https://jobs.ashbyhq.com/payzen-inc) | 8 |
| Nexxen | Ashby | [jobs.ashbyhq.com/nexxen](https://jobs.ashbyhq.com/nexxen) | 19 |
| TRM Labs | Ashby | [jobs.ashbyhq.com/trm-labs](https://jobs.ashbyhq.com/trm-labs) | 103 |
| Tipalti | Greenhouse | [job-boards.greenhouse.io/tipaltisolutions](https://job-boards.greenhouse.io/tipaltisolutions) | 25 |
| ComplyAdvantage | Greenhouse | [job-boards.greenhouse.io/complyadvantage](https://job-boards.greenhouse.io/complyadvantage) | 23 |
| Optimove | Greenhouse | [job-boards.greenhouse.io/optimove](https://job-boards.greenhouse.io/optimove) | 15 |
| Signifyd | Greenhouse | [job-boards.greenhouse.io/signifyd95](https://job-boards.greenhouse.io/signifyd95) | 13 |
| ONE ZERO Bank | Comeet | [comeet.com/jobs/onezerobank/36.00A](https://www.comeet.com/jobs/onezerobank/36.00A) | 11 |
| Overwolf | Comeet | [comeet.com/jobs/overwolf/B1.001](https://www.comeet.com/jobs/overwolf/B1.001) | 11 |
| Rapyd | Comeet | [comeet.com/jobs/rapyd/73.00E](https://www.comeet.com/jobs/rapyd/73.00E) | 32 |

SuperPlay's server-rendered page returned 17 positions. Its title markup required one reusable
`position__title` hint in the official HTML adapter before activation.

## Newly activated official HTML sources

These sources expose stable job-detail links in the server-rendered HTML. Each configuration uses
an exact same-origin path prefix and path depth; the adapter does not execute scripts or crawl
arbitrary links.

- Appcharge, Unipaas, Okoora, eToro, Mesh Payments, and monday.com.
- Stampli, Airwallex, Wise, Chargeflow, ZoomInfo, DealHub, Lusha, and Balance.

A live dry run on 2026-09-13 exercised all eleven newly recovered sources through the production
scanner. It collected 277 raw positions with no provider errors. Seven passed the current title and
location pre-filters; individual job pages are still verified and scored by the shared downstream
pipeline.

## Saved but paused sources

The remaining companies are in the watchlist, but automatic scanning is disabled until the source
can be handled reliably. Their URL is still useful for manual review and a future adapter.

### Audit result for the remaining 22

- Embedded JSON or a custom listing parser: Lemonade, HoneyBook, Monto, Earnix, Playtika, and
  Plarium.
- Reusable platform adapter: Unit21 uses Zoho Recruit; Dynamic Yield and Currencycloud use a parent
  company's Workday board and require a brand filter.
- HTTP 403 or unresolved client rendering: Papaya Global, Fiverr, Nayax, RiseUp, and PayEm.
- Broken Dueto integration: FINQ and Neema currently point to a 404 source.
- No stable public board at the audit date: PayKey, AccessFintech, OpenLegacy, BlueSnap, Finaloop,
  and Cyvers. This includes healthy-zero, parent-company, stale-provider, and LinkedIn-only cases.

These sources remain saved and explainable, but are not treated as successful daily sources until
their adapter or fallback can prove a valid job list.

## Research evidence and limitations

The category grouping is an informed comparison, not a claim that every pair is a direct
competitor. Product positioning was checked against official company and career pages. The Hebrew
University fintech ecosystem overview was also used as a taxonomy cross-check for Israeli banking,
payments, embedded-finance, and financial-infrastructure companies:
[Israeli fintech ecosystem overview](https://fintech.huji.ac.il/sites/default/files/fintech/files/sykvm_hrtst_lhkns_lhyytq_ltpqydym_1.pdf).

Representative primary sources that also confirm current role or location relevance include:
[Appcharge careers](https://www.appcharge.com/careers),
[Unipaas careers](https://www.unipaas.com/company/careers),
[IVIX careers](https://www.ivix.ai/company/careers),
[Voyantis careers](https://www.voyantis.ai/careers),
[Okoora careers](https://okoora.com/v3/career),
[Monto careers](https://montopay.com/career-in-monto),
[BioCatch on Lever](https://jobs.lever.co/biocatch), and
[TRM Labs on Greenhouse](https://job-boards.greenhouse.io/embed/job_app?for=trmlabs).

Career platforms and URLs change. A successful HTTP response proves that a source was reachable on
the research date, not that it will remain stable forever. Greenhouse, Lever, Ashby, and Workable
sources were activated only after their board identity and job content were both confirmed. A
generic Ashby page, a Greenhouse job detail page without a working board API, or a marketing page
that merely mentions an ATS was not considered sufficient evidence for activation.

## Recommended next provider work

The next reusable providers should be TeamMe for Playtika, Zoho Recruit for Unit21, and Workday for
Dynamic Yield and Currencycloud. Small bounded embedded-data parsers can then cover Lemonade,
HoneyBook, Monto, Earnix, and Plarium. Browser automation remains a fallback for sites that prove
they require JavaScript or return an anti-bot response; it should not replace stable public APIs.
