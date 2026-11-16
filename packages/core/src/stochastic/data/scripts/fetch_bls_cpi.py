"""
Download US CPI-U (all items, US city average, not seasonally adjusted; BLS series CUUR0000SA0)
directly from the Bureau of Labor Statistics and write it as `CPIAUCNS.csv` in the column layout
`build_datasets.py` reads (observation_date,CPIAUCNS). The file name and column header are kept
from an earlier build for compatibility; the values come from BLS.

BLS data is a US government work in the public domain
(https://www.bls.gov/opub/copyright-information.htm; BLS asks to be cited as the source).

Two BLS routes, tried in order:
1. the BLS Public Data API v1 (no registration or key; 10 years per request, and a small daily
   request limit per address), then
2. the BLS series report page https://data.bls.gov/timeseries/CUUR0000SA0 (all years in one
   HTML table), used when the API refuses (for example after the daily limit). `--page` skips the API.

    python3 -I fetch_bls_cpi.py <downloads dir> [first year, default 1913] [--page]
"""

import csv
import datetime
import html
import json
import os
import re
import sys
import urllib.request

API = "https://api.bls.gov/publicAPI/v1/timeseries/data/"
PAGE = "https://data.bls.gov/timeseries/CUUR0000SA0?output_view=data&include_graphs=false&years_option=all_years"
SERIES = "CUUR0000SA0"
UA = "Mozilla/5.0 (compatible; glideworth-data-build/1.0)"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


class ApiRefused(Exception):
    pass


def fetch_api(first, last):
    body = json.dumps({"seriesid": [SERIES], "startyear": str(first), "endyear": str(last)}).encode()
    req = urllib.request.Request(API, data=body, headers={"Content-Type": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    if d.get("status") != "REQUEST_SUCCEEDED":
        raise ApiRefused(f"BLS API {first}-{last}: {d.get('status')} {d.get('message')}")
    return d["Results"]["series"][0]["data"]


def from_api(first, last):
    values = {}
    for start in range(first, last + 1, 10):
        for o in fetch_api(start, min(start + 9, last)):
            p = o["period"]
            if p.startswith("M") and p != "M13" and o["value"] not in ("-", ""):
                values[(int(o["year"]), int(p[1:]))] = o["value"]
    return values


def from_page(first):
    # data.bls.gov refuses clients that do not look like a browser; no personal details are sent.
    req = urllib.request.Request(
        PAGE,
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/130.0 Safari/537.36",
            "Accept": "text/html",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "replace")
    if SERIES not in page:
        raise SystemExit("BLS page did not contain the series id; the layout may have changed")
    start = page.find('id="table0"')
    end = page.lower().find("</table>", start)
    if start < 0 or end < 0:
        raise SystemExit("BLS page: data table not found")
    table = page[start:end]
    header = re.findall(r"<TH scope=\"col\">\s*(\w+)\s*</TH>", table, re.I)
    if header[:13] != ["Year"] + MONTHS:
        raise SystemExit(f"BLS page: unexpected columns {header[:13]}")
    values = {}
    for year, cells in re.findall(r"<TH scope=\"row\">(\d{4})</TH>(.*?)</TR>", table, re.S | re.I):
        tds = [html.unescape(c).strip() for c in re.findall(r"<TD[^>]*>(.*?)</TD>", cells, re.S | re.I)]
        for m, v in enumerate(tds[:12], start=1):
            if re.fullmatch(r"\d+(\.\d+)?", v) and int(year) >= first:
                values[(int(year), m)] = v
    return values


def main():
    args = [a for a in sys.argv[1:] if a != "--page"]
    if not args:
        raise SystemExit(__doc__)
    out_dir = args[0]
    first = int(args[1]) if len(args) > 1 else 1913
    last = datetime.date.today().year
    values = None
    if "--page" not in sys.argv:
        try:
            values = from_api(first, last)
            print(f"BLS Public Data API: {len(values)} months")
        except ApiRefused as e:
            print(f"{e}; using the BLS series page instead")
    if values is None:
        values = from_page(first)
        print(f"BLS series page: {len(values)} months")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "CPIAUCNS.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["observation_date", "CPIAUCNS"])
        for (y, m) in sorted(values):
            w.writerow([f"{y:04d}-{m:02d}-01", values[(y, m)]])
    print(f"wrote {len(values)} months of BLS {SERIES} to {path}")


if __name__ == "__main__":
    main()
