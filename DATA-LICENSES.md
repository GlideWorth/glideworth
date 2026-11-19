# Data licences

Glideworth bundles historical market data (`packages/core/src/stochastic/data`) and tax tables
(`packages/core/src/tax/data`, `packages/core/src/tax/crossborder`). This file records, for each
source, where the data comes from, the licence or terms the publisher states, whether a **paid hosted
service** and an **AGPL-3.0 public repository** may use it, the attribution to display, and a status.
Software dependencies are covered separately in `THIRD-PARTY-NOTICES.md`.

Every licence statement below was read on the page linked, on **2026-11-16**, unless it is marked
**unverified** (with the reason). Nothing here is legal advice. Items marked _needs owner action_ or
_must remove_ block, or may block, the paid launch.

Status key: **ok** (usable as is, with the attribution shown) · **needs owner action** · **must remove**.

## Summary

| Item                                                           | Status                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `uk-1871` (Jordà-Schularick-Taylor)                            | **removed** 2026-11-16 (not in the public repository or its history) |
| `uk-1983` (ONS, Bank of England, Fed H.10, Damodaran)          | **ok** (registered)                                                  |
| `us-1928` stocks, bonds, bills (Damodaran)                     | **ok** (residual third-party note)                                   |
| `us-1928` inflation (BLS CPI-U, fetched from BLS)              | **ok**: rebuilt from BLS 2026-11-16, values identical                |
| `us-1871` (Shiller)                                            | **removed from the bundle**; optional personal-use download          |
| Tax tables: UK, US federal, DE, FR, ES, NL, NZ                 | **ok**                                                               |
| Tax tables: US states (re-sourced from state publications)     | **ok**; 8 states and 2 cities not confirmed (labelled), 2026-11-16   |
| Tax tables: CA (re-sourced from CRA)                           | **ok**; Quebec brackets not confirmed (labelled), 2026-11-16         |
| Tax tables: IL (PwC dropped; official sites unreachable)       | **ok on licence; figures not confirmed** (labelled), 2026-11-16      |
| Tax tables: AE (all rights reserved; copied sentence reworded) | **ok** 2026-11-16                                                    |
| Tax tables: AU, IE (licence page could not be opened or found) | **ok on facts, licence unverified**; citations official, facts only  |

## Required attribution statements

Show these on an "About the data" page in the app and in the hosted service, and keep them in the
repository (this file and `packages/core/src/stochastic/data/README.md`). The market-data statements are
also exported by core as data (`DATASET_ATTRIBUTIONS`, and `MarketDataset.attribution` per dataset); the
web app shows them in the chance-of-success dataset panel and in Settings, About; the site shows them on
its notices page:

- **UK Open Government Licence (ONS, Bank of England, GOV.UK, gov.scot):**
  "Contains public sector information licensed under the Open Government Licence v3.0."
  with a link to <https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/>, naming
  the providers: "Sources: Office for National Statistics (CPI, RPI); Bank of England (Bank Rate,
  gilt yields); HM Revenue & Customs and GOV.UK (UK tax rates); Scottish Government (Scottish rates)."
- **Federal Reserve Board:** "Exchange rates: Board of Governors of the Federal Reserve System, H.10
  Foreign Exchange Rates."
- **US Bureau of Labor Statistics:** "US inflation: U.S. Bureau of Labor Statistics, Consumer Price
  Index for All Urban Consumers (CPI-U), series CUUR0000SA0."
- **Damodaran:** "US stock, bond and bill returns: Aswath Damodaran, Historical Returns on Stocks,
  Bonds and Bills, NYU Stern (pages.stern.nyu.edu/~adamodar)." (Optional under his terms; keep it.)
- **Shiller** (only on a self-hosted installation that downloaded `us-1871-local`; not shown by the hosted
  service): "US 1871 data: Robert J. Shiller, ie_data.xls, shillerdata.com."
- **New Zealand Inland Revenue (CC BY 4.0):** "Contains material from Inland Revenue (New Zealand),
  Crown copyright, licensed under CC BY 4.0."
- **Spain (Agencia Tributaria, Seguridad Social):** cite the source and the date of last update of each
  page used (a condition of their reuse terms), for example "Source: Agencia Tributaria, Manual práctico
  IRPF 2025, updated <date>."
- **France (Etalab Licence Ouverte 2.0):** "Source: impots.gouv.fr / service-public.gouv.fr /
  BOFiP-Impôts, <date of last update>."
- **US federal agencies (IRS, SSA, HHS):** public domain; citation as a courtesy: "Source: IRS, SSA."

## Historical market datasets

### `uk-1871`: UK 1871-2020, Jordà-Schularick-Taylor Macrohistory Database R6. **Removed 2026-11-16.**

Removed from the registry, defaults, web UI, build script and working tree. Saved plans naming it are read
as `uk-1983` and show a `DATASET_REPLACED` notice. The generated file was never part of the public
repository or its history (`docs/design/uk-dataset-replacement.md`). The record below is kept to explain the
removal.

- **Source:** <https://www.macrohistory.net/database/>, file `JSTdatasetR6.xlsx` (build:
  `packages/core/src/stochastic/data/scripts/build_datasets.py`, output `jst.generated.ts`).
- **Licence (page read 2026-11-16):** CC BY-NC-SA 4.0. The page says: "We grant every user at no cost a
  license … to use and/or share the licensed material … provided that it is for non-commercial (e.g.,
  academic) purposes … Commercial data providers are thus strictly forbidden to integrate all or parts of
  the dataset into their services and/or resell the data."
- **Paid hosted service:** not allowed. **AGPL repository:** not compatible with AGPL distribution of the
  product (non-commercial + share-alike on the adapted file).
- **Action:** remove from the registry, defaults, web UI and repository, and keep it out of the public
  history. Replacement: `uk-1983` below. Plan: `docs/design/uk-dataset-replacement.md`.
- **Citation if anyone keeps a personal copy:** Jordà, Schularick and Taylor (2017), "Macrofinancial
  History and the New Business Cycle Facts", NBER Macroeconomics Annual 2016, vol. 31; Jordà, Knoll,
  Kuvshinov, Schularick and Taylor (2019), "The Rate of Return on Everything, 1870–2015", QJE 134(3).

### `uk-1983`: UK 1983-2025 (new; replaces `uk-1871`). **Ok.**

Built by `packages/core/src/stochastic/data/scripts/build_uk_open.py` into `uk-open.generated.ts`.
Registered in `MARKET_DATASETS` on 2026-11-16. Selectable for any plan; not the GB default (it is short and
optimistic; see `docs/design/uk-dataset-replacement.md`).

| Series              | Source (downloaded by the script)                                                                                                                       | Licence                                                                                                                                                                                                                                                                                                         | Commercial / AGPL | Status                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| Inflation 1989+     | ONS CPI index D7BT, <https://www.ons.gov.uk/generator?format=csv&uri=/economy/inflationandpriceindices/timeseries/d7bt/mm23>                            | OGL v3.0. ONS terms: "Most content on this website is subject to Crown copyright protection and is published under the Open Government Licence (OGL)"; exemptions are photographs, illustrations and videos. <https://www.ons.gov.uk/help/termsandconditions>                                                   | Yes / yes         | ok                                                                               |
| Inflation 1983-1988 | ONS RPI long-run index CDKO (same generator, `cdko/mm23`)                                                                                               | OGL v3.0 (as above)                                                                                                                                                                                                                                                                                             | Yes / yes         | ok                                                                               |
| Cash                | Bank of England Database, IUAABEDR (annual average Bank Rate), cross-checked with IUDBEDR (daily)                                                       | OGL v3.0. Bank legal page, "Bank of England Database": "Reproduction of data in the Database is subject to the terms of the UK Open Government Licence". Exclusion: "selected exchange rate data and series … reproduced by the Bank under licence from third parties". <https://www.bankofengland.co.uk/legal> | Yes / yes         | ok                                                                               |
| Gilts               | Bank of England Database, IUDMNZC (10-year nominal zero-coupon gilt yield)                                                                              | OGL v3.0 (as above). The series is the Bank's own curve estimate; the yield-curves page says the curves use "Bloomberg Finance L.P., Tradeweb and Bank calculations" as inputs. The Database does not flag the series as third-party. <https://www.bankofengland.co.uk/statistics/yield-curves>                 | Yes / yes         | ok (residual risk low; optional: ask yield.curve@bankofengland.co.uk to confirm) |
| USD/GBP             | Federal Reserve Board, H.10, series `RXI$US_N.B.UK` (noon buying rates), <https://www.federalreserve.gov/datadownload/Output.aspx?rel=H10&filetype=zip> | Public domain. Board disclaimer: "Unless otherwise indicated, information on Board's website is in the public domain and may be copied and distributed without permission. Please cite to the Board as the source." <https://www.federalreserve.gov/disclaimer.htm>                                             | Yes / yes         | ok                                                                               |
| Equities            | Damodaran `histretSP.xls` (see `us-1928`)                                                                                                               | As `us-1928`                                                                                                                                                                                                                                                                                                    | Yes / yes         | ok                                                                               |

The OGL v3.0 itself (read 2026-11-16, <https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/>):
you may "exploit the Information commercially and non-commercially", and must "acknowledge the source …
If the Information Provider does not provide a specific attribution statement, you must use the
following: Contains public sector information licensed under the Open Government Licence v3.0."

**Sources considered and rejected for `uk-1983`:**

- **Bank of England "A millennium of macroeconomic data" (v3.1, to 2016)**,
  <https://www.bankofengland.co.uk/statistics/research-datasets>. It is a website resource, not the
  Database, and carries no licence of its own. The Bank's legal page lets website resources be used
  "for personal use or internal use within an individual organisation for non-commercial purposes",
  unless otherwise stated. Its share-price index (sheet A31/M13) is spliced from academic indices
  (Mirowski, Acheson et al., Grossman) and, from 1962, the **FTSE All-Share index** (LSEG). It has
  **no dividend series** and corporate bond yields are "BofA Merrill Lynch Global Research, used with
  permissions". **Not usable commercially without the Bank's permission, and its equity series is
  third-party data in any case.**
- **Bank of England spot exchange rates (XUDLUSS):** the Bank's spot-rate notes say they may be built
  from Bloomberg BFIX and LSEG, with "©2025 LSEG. Republication or redistribution of LSEG content … is
  prohibited without the prior written consent of LSEG."
  <https://www.bankofengland.co.uk/statistics/details/further-details-about-spot-exchange-rates-data>.
  Replaced by Fed H.10.
- **OECD long-term interest rates and exchange rates (from 1960, via sdmx.oecd.org):** would extend
  coverage to the 1960s. **Unverified:** oecd.org returned HTTP 403 for its terms and open-access
  pages, and the SDMX dataflow metadata has no licence statement, so the CC BY 4.0 status was not
  confirmed. Not used.
- **FTSE All-Share, MSCI UK, Barclays Equity Gilt Study, Dimson-Marsh-Staunton (UBS Yearbook):**
  proprietary.
- No openly licensed UK equity total-return series covering more than a few years was found.

### `us-1928`: US 1928-2025. **Ok.**

- **Stocks, bonds, bills:** Aswath Damodaran, `histretSP.xls`,
  <https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls>. Terms (read 2026-11-16,
  <https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datahistory.html>): "I want the data to be
  widely used and to be a help, rather than a hindrance. Acknowledgements: If you do use my data and
  wish to acknowledge that you did get the data off my site, I thank you. If not, I will not lose any
  sleep and you should not either." Commercial use: not restricted. **Residual third-party note:** the
  spreadsheet's own FAQ says the stock series is the S&P 500 (an S&P Dow Jones Indices index),
  back-filled before 1957, and the bond and bill yields and CPI are "reported on FRED". The redistributed
  values are annual index levels and dividends. Third-party rights in them are **unverified**; the
  same figures are widely republished.
- **Inflation:** BLS CPI-U, all items, NSA (series CUUR0000SA0). **Until 2026-11-16 the build downloaded
  this series through FRED**, whose terms (read 2026-11-16, <https://fred.stlouisfed.org/legal/>) forbid
  storing or caching FRED content and commercial use of FRED services without consent. The build now
  fetches it from BLS only (`packages/core/src/stochastic/data/scripts/fetch_bls_cpi.py`: the BLS Public Data API, or the BLS series page
  <https://data.bls.gov/timeseries/CUUR0000SA0> when the API's daily limit is reached), and FRED has been
  removed from the scripts and data docs.
  - The numbers are BLS data. BLS: "everything that we publish … is in the public domain, except for
    previously copyrighted photographs and illustrations … we do ask that you cite the Bureau of Labor
    Statistics as the source." <https://www.bls.gov/opub/copyright-information.htm>. US government works
    have no copyright: 17 U.S.C. §105, <https://www.law.cornell.edu/uscode/text/17/105>.
  - **Checked 2026-11-16:** BLS CUUR0000SA0 from the BLS Public Data API v1 reproduces all 98
    December-to-December values of `us-1928` (1928-2025) exactly (max difference 0 at 6 dp).
  - **Done 2026-11-16:** rebuilt from BLS (the BLS series page; the API had hit its daily limit) with
    `fetch_bls_cpi.py` then `build_datasets.py`. All 98 years x 6 series (588 values) of the rebuilt
    `us-1928` equal the previously committed values (one value differs only in how the number is
    written: `-3.2e-5` vs `-3.2e-05`).
- **Status:** ok.

### `us-1871`: US 1871-2025, Robert Shiller. **Removed from the bundle 2026-11-16 (cautious option).**

Removed: the generated data, the registry entry and the build code. Deterministic `RateSpec.historical`
sequences (`HISTORICAL_SERIES`) now read `us-1928`; a sequence that starts before 1928 starts in 1928 with
a warning. The FIRECalc validation test now runs on `us-1928` (explained in the test and in
`docs/ARCHITECTURE.md` §4.4). Saved plans naming `us-1871` are read as `us-1928` with a `DATASET_REPLACED`
notice. Self-hosters may fetch the data from the original source for personal use with
`packages/core/src/stochastic/data/scripts/fetch_shiller_local.py` (dataset `us-1871-local`, loaded from `GLIDEWORTH_LOCAL_DATA_DIR`, Node
only); it is never committed and never part of the hosted service or the browser bundle. Option 1 below
(written permission) would allow bundling it again.

- **Source:** `ie_data.xls`, <https://shillerdata.com/> (October 2026 update), plus Damodaran T-bills
  from 1928 for cash.
- **Licence:** none stated. The page (read 2026-11-16) carries only a disclaimer ("No representation is
  made as to the accuracy of the assumptions made within, or completeness of, any modelling …"). No
  licence, copyright notice or terms of use were found. The underlying index data is the S&P
  composite (S&P, Cowles Commission) and CPI.
- **Paid hosted service / AGPL repo:** no explicit permission. "Openly published" is not a licence.
- **Options for the owner:**
  1. Ask Prof. Shiller in writing for permission to redistribute the derived annual series in an AGPL
     repository and use it in a paid service. Keep attribution.
  2. Remove `us-1871` from the bundle. Note that `HISTORICAL_SERIES` in
     `packages/core/src/stochastic/data/index.ts` (deterministic `RateSpec.historical` sequences) reads
     `us-1871`. It would need to switch to `us-1928`, losing 1871-1927.
  3. Ship a downloader instead of the data: self-hosters fetch `ie_data.xls` themselves and the build
     runs locally. The hosted service does not offer the dataset.
  4. Keep it, with attribution, as a business decision on residual risk (common practice among open
     retirement calculators, but not a grant of rights).

### Not bundled

Crypto has no history (drawn from a distribution). No global equity index (MSCI, DMS are proprietary).

## Tax tables

Tax rates, thresholds and allowances are facts transcribed from official publications. The files
hold numbers, short source notes and Glideworth's own explanatory text ("simplifications").

**Verbatim-text check (2026-11-16).** Every string literal and comment of 60+ characters in
`tax/data/*.ts` and `tax/crossborder/*.ts` was compared with the text of each cited HTML page that could
be fetched, looking for any shared run of 10 consecutive words (URLs excluded). 104 file-to-page
comparisons succeeded (a URL cited in two files counts twice). Not checked: PDFs and pages that returned 403, 404 or 429 (ATO, CRA, Revenu
Québec, AEAT IRPF manual, gov.il booklet, SSA, several US city pages, centralbank.ae, difc.com). Findings:

- `tax/data/ae.ts` reproduced one sentence fragment from u.ae (the scope of the GPSSA law). The u.ae
  terms reserve all rights, so it was rewritten in Glideworth's own words on 2026-11-16 (same facts and
  citation); the site's UAE page was reworded to match.
- `tax/data/fr.ts` quotes the title of the finance law ("loi n° 2026-103 du 19 février 2026 de finances
  pour 2026"). A statute title; fine.
- Nothing else. The explanatory text is the project's own.

| Country / file                                                                              | Official sources cited in code                                                                                                                                                                                                                        | Publisher's licence (checked 2026-11-16)                                                                                                                                                                                                                                                                                                                                                                                   | Commercial use / AGPL                         | Attribution         | Status                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UK `uk.ts`, `crossborder/uk.ts`, `treaties.ts`, `nonresident.ts` (UK parts)                 | gov.uk (Budget 2025, OOTLAR annex A, HMRC guidance and manuals, treaties), gov.scot                                                                                                                                                                   | **OGL v3.0.** GOV.UK: "Most content on GOV.UK is subject to Crown copyright protection and is published under the Open Government Licence (OGL)" <https://www.gov.uk/help/terms-conditions>. gov.scot footer: "All content is available under the Open Government Licence v3.0, except for graphic assets" (read from a gov.scot page footer; the /copyright URL returned 404)                                             | Yes / yes                                     | OGL statement above | ok                                                                                                                                                                                                                                                         |
| US federal `us-federal.ts`, crossborder US parts                                            | irs.gov, ssa.gov, aspe.hhs.gov, ecfr.gov                                                                                                                                                                                                              | **Public domain**, 17 U.S.C. §105 ("Copyright protection … is not available for any work of the United States Government") <https://www.law.cornell.edu/uscode/text/17/105>                                                                                                                                                                                                                                                | Yes / yes                                     | Courtesy citation   | ok                                                                                                                                                                                                                                                         |
| US states `us-states.ts`, `us-state.ts`                                                     | Each state's revenue department, statute or 2026 forms (51 rows, every row lists its own `sources`, read 2026-11-16); cities: tax.ny.gov (NYC rates), phila.gov, detroitmi.gov, wilmingtonde.gov, newarknj.gov. The Tax Foundation is no longer cited | State and city government publications; rates, thresholds and dates are facts, and only facts are taken (notes are Glideworth's wording). State sites' reuse terms were not each checked; state works are not covered by 17 U.S.C. §105, but no text is reproduced                                                                                                                                                         | Facts yes / yes                               | Courtesy citation   | **ok** (2026-11-16). Not confirmed from an official source (site would not open): ID, KS, LA, MI, NH, OH, RI, WI, and the Wilmington and Newark rates; some figures of AZ, GA, IA, KY, MO, OK, SC, VT, WV. Each is labelled in the state's simplifications |
| Canada `ca.ts`, crossborder CA parts                                                        | canada.ca (CRA): current-year rates and brackets, indexation amounts, T4127 (January 2026), 2026 TD1 forms, CPP, CPP2 and EI pages (read 2026-11-16); revenuquebec.ca (could not be opened). taxtips.ca removed                                       | **canada.ca:** reproduction allowed "for non-commercial purposes"; "you may not reproduce materials on this site, in whole or in part, for the purposes of commercial redistribution" without permission <https://www.canada.ca/en/transparency/terms.html> (read via a fetcher; curl was refused). Applies to reproducing materials, not to the rates as facts. Revenu Québec: unverified (refused automated access)      | Facts yes; no CRA text may be copied          | Courtesy citation   | **ok** (2026-11-16). Quebec brackets and basic amount not confirmed from an official source (labelled)                                                                                                                                                     |
| Australia `au.ts`, crossborder AU parts                                                     | ato.gov.au; budget.gov.au (2026-27 Budget Paper No. 2, Medicare levy thresholds, read 2026-11-16)                                                                                                                                                     | **Unverified:** ato.gov.au returned 403 to every fetch, including the copyright page (again 2026-11-16)                                                                                                                                                                                                                                                                                                                    | Facts yes (INFERRED)                          | ATO citation        | ok on facts; citations are official pages and only facts are taken (2026-11-16); owner may confirm the ATO licence                                                                                                                                         |
| Germany `de.ts`                                                                             | gesetze-im-internet.de (EStG, SolZG, InvStG), DRV, BMG, Bundesregierung                                                                                                                                                                               | **Statutes have no copyright:** §5(1) UrhG: "Gesetze, Verordnungen, amtliche Erlasse und Bekanntmachungen … genießen keinen urheberrechtlichen Schutz" <https://www.gesetze-im-internet.de/urhg/__5.html>. DRV/BMG pages: not checked; values used are facts                                                                                                                                                               | Yes / yes                                     | Courtesy citation   | ok                                                                                                                                                                                                                                                         |
| France `fr.ts`                                                                              | impots.gouv.fr, bofip.impots.gouv.fr, service-public.gouv.fr, urssaf.fr, agirc-arrco                                                                                                                                                                  | **Etalab Licence Ouverte 2.0** (impots.gouv.fr <https://www.impots.gouv.fr/mentions-legales>; bofip and service-public footers). **URSSAF: ODbL** ("informations publiques librement réutilisables sous réserve du respect de la licence Open Database License") <https://www.urssaf.fr/accueil/mentions-legales.html>. A few figures (the social security ceiling) are an insubstantial extract. Agirc-Arrco: not checked | Yes / yes                                     | Source + date       | ok                                                                                                                                                                                                                                                         |
| Spain `es.ts`, crossborder ES parts                                                         | sede.agenciatributaria.gob.es, seg-social.es, boe.es (statute text; laws carry no copyright, LPI art. 13)                                                                                                                                             | **AEAT:** reuse authorised "para usos comerciales y no comerciales", on condition of not distorting the content, citing the source and the date of last update <https://sede.agenciatributaria.gob.es/Sede/condiciones-uso-sede-electronica/aviso-legal/utilizacion-informacion-contenida-web-aeat.html>. **Seguridad Social:** same conditions <https://www.seg-social.es/wps/portal/wss/internet/AvisoLegal>             | Yes / yes                                     | Source + date       | ok                                                                                                                                                                                                                                                         |
| Netherlands `nl.ts`                                                                         | belastingdienst.nl, rijksoverheid.nl                                                                                                                                                                                                                  | **CC0.** Belastingdienst: "Creative Commons Zero verklaring … zowel voor commerciële als niet-commerciële doeleinden" <https://www.belastingdienst.nl/wps/wcm/connect/bldcontentnl/niet_in_enig_menu/prive/copyright>; Rijksoverheid: CC0 1.0 <https://www.rijksoverheid.nl/copyright>                                                                                                                                     | Yes / yes                                     | None required       | ok                                                                                                                                                                                                                                                         |
| Ireland `ie.ts`                                                                             | revenue.ie, assets.gov.ie (PRSI guide PDF); CGT page re-read 2026-11-16 (31% from 7 October 2026)                                                                                                                                                     | **Unverified:** revenue.ie's copyright-statement URL has no reuse statement and gov.ie's copyright page returned 404                                                                                                                                                                                                                                                                                                       | Facts yes (INFERRED)                          | Courtesy citation   | ok on facts; citations official, facts only (2026-11-16); owner may confirm                                                                                                                                                                                |
| Israel `il.ts`                                                                              | fs.knesset.gov.il (Book of Laws, Knesset Research and Information Center), btl.gov.il (Internet Archive copy); gov.il cited                                                                                                                           | Facts and statutory figures only, no text copied. Statutes carry no copyright (Copyright Law 2007 s. 6). gov.il and btl.gov.il refuse automated access (2026-11-19)                                                                                                                                                                                                                                                        | Facts yes                                     | n/a                 | **ok** (checked 2026-11-19); the 25% capital-income rates are not confirmed (labelled in `il.ts` and STATUS.md)                                                                                                                                            |
| New Zealand `nz.ts`                                                                         | ird.govt.nz                                                                                                                                                                                                                                           | **CC BY 4.0.** "You can reproduce our Crown copyright material free of charge without further permission under the Creative Commons Attribution 4.0 International licence, as long as you … acknowledge the source" <https://www.ird.govt.nz/about-this-site/conditions-of-use/copyright>                                                                                                                                  | Yes / yes                                     | CC BY line above    | ok                                                                                                                                                                                                                                                         |
| UAE `ae.ts`, crossborder AE parts                                                           | tax.gov.ae, mof.gov.ae, u.ae, mohre.gov.ae, gpssa.gov.ae, difc.com, centralbank.ae                                                                                                                                                                    | **All rights reserved.** FTA: "None of the content on the Website may be … copied, reproduced … without the prior written consent of the FTA", except non-commercial personal reference <https://tax.gov.ae/en/content/terms.conditions.aspx>. MOF and u.ae: "Any unauthorised use, reproduction … is strictly prohibited" <https://mof.gov.ae/en/copyright/>, <https://u.ae/en/Footer/Copyright>                          | Rates and rules as facts yes; no text copying | n/a                 | **ok**: the copied sentence was reworded 2026-11-16                                                                                                                                                                                                        |
| Cross-border summaries (`crossborder/explain.ts`, `types.ts`, `currency.ts`, `wrappers.ts`) | no external text; `wrappers.ts` cites the UK-US treaty on gov.uk (OGL)                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                                                          | Yes / yes                                     | —                   | ok                                                                                                                                                                                                                                                         |

## Change log

- 2026-11-16: first audit (data-licensing blocker for the paid launch).
- 2026-11-16: `uk-1871` removed and `uk-1983` registered; `us-1871` removed from the bundle (optional local
  download); `us-1928` inflation rebuilt from BLS (identical values), FRED removed from the build;
  attribution statements exported from core.
- 2026-11-16: tax tables re-sourced. US state table checked state by state against each state's own
  publications (Tax Foundation citation removed); Canada re-sourced from CRA (taxtips.ca removed); PwC
  removed from Israel; UAE sentence reworded. Figures that could not be confirmed from an official source
  are labelled in the data files, the simplification lists and `docs/STATUS.md`.
