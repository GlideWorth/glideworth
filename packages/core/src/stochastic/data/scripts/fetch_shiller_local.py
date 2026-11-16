"""
OPTIONAL, PERSONAL USE: download Robert Shiller's US market data (1871 onwards) and convert it into
the dataset `us-1871-local`, for a self-hosted Glideworth installation.

Why this is a separate download: Shiller publishes ie_data.xls openly at https://shillerdata.com/
but states no licence, so Glideworth does not redistribute it (not in the repository, the npm or
Docker builds, the browser bundle, or the hosted service). Running this script downloads it from the
original source on your own machine, for your own use. Do not commit the output.

Usage:

    uv run --with xlrd python -I fetch_shiller_local.py <output dir> [--xls <ie_data.xls you downloaded>]

    # then tell the engine where it is (Node: API server, CLI, MCP; not the browser app):
    export GLIDEWORTH_LOCAL_DATA_DIR=<output dir>

Without `--xls` the script reads https://shillerdata.com/ to find the ie_data.xls link and downloads
it. It also downloads Damodaran's histretSP.xls for 3-month T-bill rates (Shiller has no bill
series; cash is null before 1928 and the plan's cash assumption is used there). It writes
`<output dir>/us-1871.json`, which the engine loads as dataset `us-1871-local` when
GLIDEWORTH_LOCAL_DATA_DIR points at the directory. Keep the directory outside the repository (for
example ~/glideworth-local-data); `data-local/` at the repository root is git- and docker-ignored.

Construction for year y (January to January; unchanged from the dataset Glideworth used to bundle):
  stocks        = P(Jan y+1) / P(Jan y) - 1                       (S&P composite, monthly average price)
  dividendYield = sum over Jan..Dec y of D(m)/12, divided by P(Jan y)
  bond total    = product of Shiller's monthly total bond returns for Jan..Dec y, minus 1
  bondYield     = mean GS10 over Jan..Dec y (decimal); bonds = bond total - bondYield
  inflation     = CPI(Jan y+1) / CPI(Jan y) - 1
  cash          = Damodaran 3-month T-bill (1928 on), else null
"""
import json
import os
import re
import sys
import urllib.request

import xlrd

UA = "Mozilla/5.0 (compatible; glideworth-local-data/1.0)"
SHILLER_PAGE = "https://shillerdata.com/"
DAMODARAN = "https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls"


def r6(x):
    return None if x is None else round(float(x), 6)


def download(url, path):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    with open(path, "wb") as f:
        f.write(body)
    print("downloaded", url, len(body), "bytes")


def shiller_xls_url():
    req = urllib.request.Request(SHILLER_PAGE, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        page = r.read().decode("utf-8", "replace")
    links = re.findall(r'href="([^"]*ie_data\.xls[^"]*)"', page)
    if not links:
        raise SystemExit(
            "Could not find the ie_data.xls link on shillerdata.com. Download it by hand and pass --xls <file>."
        )
    url = links[0]
    return url if url.startswith("http") else "https:" + url if url.startswith("//") else SHILLER_PAGE.rstrip("/") + url


def damodaran_tbills(path):
    ret = xlrd.open_workbook(path).sheet_by_name("Returns by year")
    tbill = {}
    for r in range(20, ret.nrows):
        y = ret.cell_value(r, 0)
        if not isinstance(y, float):
            break
        tbill[int(y)] = ret.cell_value(r, 3)
    return tbill


def build(ie_path, tbill):
    sh = xlrd.open_workbook(ie_path).sheet_by_name("Data")
    rows = {}
    for r in range(8, sh.nrows):
        d = sh.cell_value(r, 0)
        if not isinstance(d, float):
            continue
        y = int(d)
        m = int(round((d - y) * 100))
        rows[(y, m)] = dict(
            P=sh.cell_value(r, 1),
            D=sh.cell_value(r, 2),
            CPI=sh.cell_value(r, 4),
            GS10=sh.cell_value(r, 6),
            BR=sh.cell_value(r, 17),  # monthly gross nominal 10y bond total return, month m -> m+1
        )
    years = []
    s = {k: [] for k in ["stocks", "dividendYield", "bonds", "bondYield", "cash", "inflation"]}
    y = 1871
    while (y + 1, 1) in rows and all(
        rows.get((y, m), {}).get("D") not in ("", None) and rows.get((y, m), {}).get("BR") not in ("", None)
        for m in range(1, 13)
    ):
        j0, j1 = rows[(y, 1)], rows[(y + 1, 1)]
        months = [rows[(y, m)] for m in range(1, 13)]
        dy = sum(mm["D"] / 12 for mm in months) / j0["P"]
        bond_tr = 1.0
        for mm in months:
            bond_tr *= mm["BR"]
        bond_tr -= 1
        coupon = sum(mm["GS10"] for mm in months) / 12 / 100
        years.append(y)
        s["stocks"].append(r6(j1["P"] / j0["P"] - 1))
        s["dividendYield"].append(r6(dy))
        s["bondYield"].append(r6(coupon))
        s["bonds"].append(r6(bond_tr - coupon))
        s["cash"].append(r6(tbill[y]) if y in tbill else None)
        s["inflation"].append(r6(j1["CPI"] / j0["CPI"] - 1))
        y += 1
    return years, s


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith("-"):
        raise SystemExit(__doc__)
    out_dir = args[0]
    xls = args[args.index("--xls") + 1] if "--xls" in args else None
    os.makedirs(out_dir, exist_ok=True)
    if xls is None:
        xls = os.path.join(out_dir, "ie_data.xls")
        download(shiller_xls_url(), xls)
    hist = os.path.join(out_dir, "histretSP.xls")
    download(DAMODARAN, hist)
    years, s = build(xls, damodaran_tbills(hist))
    path = os.path.join(out_dir, "us-1871.json")
    with open(path, "w") as f:
        json.dump(
            {
                "source": "Robert J. Shiller, ie_data.xls (shillerdata.com); cash: Damodaran histretSP.xls. "
                "Downloaded for personal use; not for redistribution.",
                "firstYear": years[0],
                "lastYear": years[-1],
                "series": s,
            },
            f,
        )
    print(f"wrote {path}: {years[0]}-{years[-1]}. Set GLIDEWORTH_LOCAL_DATA_DIR={os.path.abspath(out_dir)}")


if __name__ == "__main__":
    main()
