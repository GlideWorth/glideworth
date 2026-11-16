"""
Build the openly licensed UK dataset `uk-1983` (sterling, calendar years 1983 to the latest
complete year) and write `uk-open.generated.ts` next to the other generated modules.

It replaces `uk-1871` (Jorda-Schularick-Taylor, CC BY-NC-SA 4.0), which cannot ship in a paid
product. Decision, licences and the statistical comparison: docs/design/uk-dataset-replacement.md
and DATA-LICENSES.md at the repo root.

Usage (downloads go in a directory you choose, outside the repo; keep this script elsewhere):

    uv run --with xlrd python -I build_uk_open.py --fetch /tmp/glideworth-uk-data \
        <repo>/packages/core/src/stochastic/data
    # uk-open.generated.ts is excluded from the formatter and linter: there is no format step.

`--fetch` downloads the inputs listed in SOURCES into the directory first; without it the files
must already be there under the same names. Every value is an arithmetic transformation of a
source cell (documented per series below), rounded to 6 decimal places. Nothing is typed in.

Series (year y, all decimals):
- inflation  UK consumer prices, December to December (to match calendar-year returns).
             1989 onwards: ONS CPI index D7BT (2015=100). 1983-1988: ONS RPI long-run index CDKO
             (CPI starts in January 1988, so Dec 1987 to Dec 1988 has no CPI value). Source: ONS, OGL v3.0.
- cash       Bank of England Official Bank Rate, annual average (IADB IUAABEDR). OGL v3.0.
- bondYield  coupon of a 10-year gilt bought at par at the end of y-1: the 10-year nominal
             zero-coupon gilt yield (IADB IUDMNZC, last observation of December y-1), converted from
             the Bank's continuous compounding to annual compounding: exp(z) - 1. OGL v3.0.
- bonds      price change of that bond at the end of y, repriced as a 9-year annual-coupon bond at
             the end-y yield (same conversion); bonds + bondYield is the bond's total return.
- stocks     S&P 500 price return (Damodaran, histretSP.xls, the same source as `us-1928`) for a
             sterling investor, unhedged: (P(y)/P(y-1)) * (FX(y-1)/FX(y)) - 1, where FX is US dollars
             per pound at the last December noon buying rate (Federal Reserve Board H.10, series
             RXI$US_N.B.UK; public domain). There is no openly licensed long UK equity series.
- dividendYield  Damodaran's dividends D(y)/P(y-1), converted at the same rates (FX(y-1)/FX(y)),
             so stocks + dividendYield is exactly the sterling total return. No withholding tax.
"""

import csv
import json
import math
import os
import re
import sys
import urllib.request
import zipfile

import xlrd

UA = "Mozilla/5.0 (compatible; glideworth-data-build/1.0)"
IADB = (
    "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes"
    "&Datefrom=01/Jan/1963&Dateto=now&SeriesCodes={code}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N"
)
ONS = "https://www.ons.gov.uk/generator?format=csv&uri=/economy/inflationandpriceindices/timeseries/{cdid}/mm23"
SOURCES = {
    "histretSP.xls": "https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls",
    "h10.zip": "https://www.federalreserve.gov/datadownload/Output.aspx?rel=H10&filetype=zip",
    "ons_d7bt.csv": ONS.format(cdid="d7bt"),
    "ons_cdko.csv": ONS.format(cdid="cdko"),
    "boe_IUDMNZC.csv": IADB.format(code="IUDMNZC"),
    "boe_IUAABEDR.csv": IADB.format(code="IUAABEDR"),
    "boe_IUDBEDR.csv": IADB.format(code="IUDBEDR"),
}
FIRST_YEAR = 1983  # the first year with a December 10-year gilt yield for the previous year (IADB starts 1982)
CPI_FROM = 1989  # first year with a CPI December-to-December change
MONTHS = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def fetch(src):
    os.makedirs(src, exist_ok=True)
    for name, url in SOURCES.items():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read()
        if name.endswith(".csv") and body.lstrip().startswith(b"<"):
            raise SystemExit(f"{name}: got HTML instead of CSV from {url}")
        with open(os.path.join(src, name), "wb") as f:
            f.write(body)
        print("fetched", name, len(body), "bytes")


def r6(x):
    return round(float(x), 6)


# ------------------------------------------------------------------ readers
def ons_monthly(path):
    """ONS generator CSV -> {(year, month): value} (monthly rows look like "2022 DEC","127.2")."""
    out = {}
    with open(path, newline="") as f:
        for row in csv.reader(f):
            if len(row) == 2 and re.fullmatch(r"\d{4} [A-Z]{3}", row[0]) and row[1]:
                y, m = row[0].split()
                out[(int(y), MONTHS[m])] = float(row[1])
    return out


def iadb(path):
    """IADB CSV ("DATE,CODE" then "02 Jan 1975,11.5") -> sorted [(year, month, day, value)]."""
    out = []
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    if not rows or rows[0][0] != "DATE":
        raise SystemExit(f"{path}: not an IADB CSV")
    for d, v in rows[1:]:
        dd, mon, yyyy = d.split()
        out.append((int(yyyy), MONTHS[mon.upper()], int(dd), float(v)))
    return sorted(out)


def last_in_december(obs, year):
    dec = [o for o in obs if o[0] == year and o[1] == 12]
    if not dec:
        raise SystemExit(f"no December {year} observation")
    return dec[-1][-1]


def h10_usd_per_gbp(path):
    """Fed H.10 package -> sorted [(year, month, day, USD per GBP)] for RXI$US_N.B.UK."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("h10_data.xml").decode()
    m = re.search(r'SERIES_NAME="RXI\$US_N\.B\.UK".*?</kf:Series>', xml, re.S)
    if not m:
        raise SystemExit("RXI$US_N.B.UK not found in the H.10 package")
    out = []
    for attrs in re.findall(r"<frb:Obs ([^>]*)/>", m.group(0)):
        a = dict(re.findall(r'(\w+)="([^"]*)"', attrs))
        if a.get("OBS_STATUS") != "A":
            continue  # ND (no data) days
        y, mo, d = (int(x) for x in a["TIME_PERIOD"].split("-"))
        out.append((y, mo, d, float(a["OBS_VALUE"])))
    return sorted(out)


def damodaran(path):
    wb = xlrd.open_workbook(path)
    raw = wb.sheet_by_name("S&P 500 & Raw Data")
    price, divs = {}, {}
    for r in range(2, raw.nrows):
        y = raw.cell_value(r, 0)
        if isinstance(y, float):
            price[int(y)] = raw.cell_value(r, 1)
            divs[int(y)] = raw.cell_value(r, 2)
    return price, divs


# ------------------------------------------------------------------ construction
def annual_rate(z_percent):
    """BoE zero-coupon yields are continuously compounded (BoE yield-curve FAQ); -> annual rate."""
    return math.exp(z_percent / 100) - 1


def par_bond_price(coupon, y, n):
    """Price per 1 of face of an n-year annual-coupon bond at annual yield y."""
    if abs(y) < 1e-12:
        return coupon * n + 1
    return coupon * (1 - (1 + y) ** -n) / y + (1 + y) ** -n


def build(src):
    cpi = ons_monthly(os.path.join(src, "ons_d7bt.csv"))
    rpi = ons_monthly(os.path.join(src, "ons_cdko.csv"))
    zc = iadb(os.path.join(src, "boe_IUDMNZC.csv"))
    bank_annual = {y: v for y, _, _, v in iadb(os.path.join(src, "boe_IUAABEDR.csv"))}
    bank_daily = iadb(os.path.join(src, "boe_IUDBEDR.csv"))
    fx = h10_usd_per_gbp(os.path.join(src, "h10.zip"))
    price, divs = damodaran(os.path.join(src, "histretSP.xls"))

    def complete(y):
        """True when every input has the observations year y needs (December values, annual rows)."""
        idx = cpi if y >= CPI_FROM else rpi
        return (
            (y, 12) in idx
            and (y - 1, 12) in idx
            and y in price
            and y in bank_annual
            and any(o[0] == y and o[1] == 12 for o in zc)
            and any(o[0] == y and o[1] == 12 for o in fx)
        )

    if not complete(FIRST_YEAR):
        raise SystemExit(f"inputs do not cover {FIRST_YEAR}")
    last = FIRST_YEAR
    while complete(last + 1):
        last += 1

    years = list(range(FIRST_YEAR, last + 1))
    s = {k: [] for k in ["stocks", "dividendYield", "bonds", "bondYield", "cash", "inflation"]}
    for y in years:
        # inflation, December to December
        idx = cpi if y >= CPI_FROM else rpi
        s["inflation"].append(r6(idx[(y, 12)] / idx[(y - 1, 12)] - 1))

        # cash: published annual average Bank Rate; cross-checked against the mean of daily values
        daily = [v for yy, _, _, v in bank_daily if yy == y]
        assert abs(sum(daily) / len(daily) - bank_annual[y]) < 0.05, (y, bank_annual[y])
        s["cash"].append(r6(bank_annual[y] / 100))

        # gilts
        c = annual_rate(last_in_december(zc, y - 1))
        y1 = annual_rate(last_in_december(zc, y))
        s["bondYield"].append(r6(c))
        s["bonds"].append(r6(par_bond_price(c, y1, 9) - 1))

        # US equities in sterling
        conv = last_in_december(fx, y - 1) / last_in_december(fx, y)
        p0, p1 = price[y - 1], price[y]
        s["stocks"].append(r6(p1 / p0 * conv - 1))
        s["dividendYield"].append(r6(divs[y] / p0 * conv))
    return years, s


HEADER = """// GENERATED by data/scripts/build_uk_open.py. Do not edit by hand; see data/README.md and
// docs/design/uk-dataset-replacement.md.
// UK 'uk-1983' (sterling, calendar years). Sources and licences (see DATA-LICENSES.md):
//   inflation: Office for National Statistics, CPI index D7BT (1989 on) and RPI long-run index CDKO
//     (1983-1988), December to December.
//   cash: Bank of England, Official Bank Rate annual average (IUAABEDR).
//   gilts: Bank of England, 10-year nominal zero-coupon gilt yield (IUDMNZC), repriced as a par bond.
//   Contains public sector information licensed under the Open Government Licence v3.0.
//   equities: S&P 500 price and dividends from Aswath Damodaran, histretSP.xls (NYU Stern), converted to
//     sterling at Federal Reserve Board H.10 noon buying rates (RXI$US_N.B.UK). These are US equities
//     held by a sterling investor, not UK equities.
"""


def main():
    args = sys.argv[1:]
    do_fetch = "--fetch" in args
    args = [a for a in args if a != "--fetch"]
    if len(args) != 2:
        raise SystemExit(__doc__)
    src, out = args
    if do_fetch:
        fetch(src)
    years, s = build(src)
    series = ",\n".join(f"    {k}: {json.dumps(v)}" for k, v in s.items())
    path = os.path.join(out, "uk-open.generated.ts")
    with open(path, "w") as f:
        f.write(HEADER + "import type { RawHistoricalData } from './raw.js';\n")
        f.write(
            f"\nexport const UK_1983_RAW: RawHistoricalData = {{\n  firstYear: {years[0]},\n"
            f"  lastYear: {years[-1]},\n  series: {{\n{series},\n  }},\n}};\n"
        )
    print("uk-1983", years[0], years[-1], "->", path)


if __name__ == "__main__":
    main()
