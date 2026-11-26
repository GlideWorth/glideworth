/**
 * CSV tab: OFX/QFX/QIF are refused (#147), and missing columns use the mapping form's words (#149).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requiredColumnNote, unsupportedBankFileMessage } from "../src/features/import/csv-file";
import { FIELDS } from "../src/features/import/csv-import";
import { createAppRouter } from "../src/router";
import { useUi } from "../src/stores/ui";
import { apiError, json } from "./cloud-helpers";

const OFX = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>GBP
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20261101
<TRNAMT>-12.50
<NAME>Tesco
</STMTTRN>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const QIF = `!Type:Bank
D01/11/2026
T-12.50
PTesco
^
`;

const CLOUD_SIGNED_IN = {
  mode: "cloud",
  authenticated: true,
  user: { id: "u1", email: "ada@example.com", name: "Ada", role: "owner", totp: false },
  workspace: {
    id: "acc_1",
    name: "Home",
    role: "owner",
    access: { level: "full", reason: "trial", changesAt: null },
    trialEndsAt: "2026-12-02T22:08:00.000Z",
  },
  workspaces: [{ id: "acc_1", name: "Home", role: "owner", access: null }],
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname === "/api/v1/auth/status") return json(CLOUD_SIGNED_IN);
      if (url.pathname === "/api/v1/households") return json({ items: [] });
      return apiError(404, "NOT_FOUND", "not found");
    }),
  );
}

async function openCsvTab() {
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/import?tab=csv"] }));
  await router.load();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByText("What is in the file?");
}

function fileOf(name: string, text: string) {
  return new File([text], name, { type: "application/octet-stream" });
}

function dropFile(name: string, text: string) {
  const zone = screen.getByText("Choose a CSV file").closest("label");
  if (!zone) throw new Error("drop zone missing");
  fireEvent.drop(zone, { dataTransfer: { files: [fileOf(name, text)] } });
}

function chooseFile(name: string, text: string) {
  const input = document.querySelector("input[type=file]") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf(name, text)] } });
}

beforeEach(() => {
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  Element.prototype.scrollTo ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

afterEach(() => {
  cleanup();
  useUi.getState().setNavOpen(false);
  vi.unstubAllGlobals();
});

describe("bank files on the CSV tab", () => {
  it("names OFX, QFX and QIF, and leaves a real CSV alone", () => {
    expect(
      unsupportedBankFileMessage({ name: "qa-sample.ofx", text: OFX }, "account-balances"),
    ).toBe(
      "OFX files are not supported. Export the statement as a CSV and drop that file here. A header row such as Account name, Balance matches this choice.",
    );
    expect(
      unsupportedBankFileMessage({ name: "stmt.QFX", text: OFX }, "progress-snapshots"),
    ).toMatch(/^QFX files are not supported\..*Date, Net worth/);
    expect(
      unsupportedBankFileMessage({ name: "qif-sample.qif", text: QIF }, "transactions"),
    ).toMatch(/^QIF files are not supported\..*Date, Amount \(signed\), Category/);
    expect(
      unsupportedBankFileMessage({ name: "export.txt", text: `\uFEFF${OFX}` }, "account-balances"),
    ).toMatch(/^OFX files are not supported/);
    expect(
      unsupportedBankFileMessage(
        { name: "weird.ofx", text: "not really a statement" },
        "account-balances",
      ),
    ).toMatch(/^OFX files are not supported/);
    expect(
      unsupportedBankFileMessage(
        {
          name: "balances.csv",
          text: "Date,Description,Amount\n2026-01-01,OFXHEADER:100 transfer,-1\n",
        },
        "transactions",
      ),
    ).toBeNull();
    expect(
      unsupportedBankFileMessage(
        { name: "balances.csv", text: "Account name,Balance\nCash,10\n" },
        "account-balances",
      ),
    ).toBeNull();
  });

  it("refuses a dropped OFX file and does not open it as a spreadsheet", async () => {
    stubFetch();
    await openCsvTab();
    dropFile("qa-sample.ofx", OFX);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/OFX files are not supported/);
    expect(alert.textContent).toMatch(/Account name, Balance/);
    expect(screen.queryByText("Column mapping")).toBeNull();
    expect(screen.queryByRole("button", { name: "Another file" })).toBeNull();
    expect(document.body.textContent).not.toMatch(/OFXHEADER/);
  });

  it("refuses a dropped QIF file on the transactions choice", async () => {
    stubFetch();
    await openCsvTab();
    fireEvent.click(screen.getByRole("radio", { name: /Transactions/ }));
    dropFile("qif-sample.qif", QIF);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/QIF files are not supported/);
    expect(alert.textContent).toMatch(/Date, Amount \(signed\), Category/);
    expect(screen.queryByText("Column mapping")).toBeNull();
  });

  it("refuses a QFX file chosen from the file dialog, then accepts a CSV", async () => {
    stubFetch();
    await openCsvTab();
    fireEvent.click(screen.getByRole("radio", { name: /Net-worth history/ }));
    chooseFile("stmt.qfx", OFX);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /QFX files are not supported[\s\S]*Date, Net worth/,
    );
    chooseFile("balances.csv", "Account name,Balance\nCash,10\n");
    expect(await screen.findByText("Column mapping")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(/1 rows/)).toBeTruthy();
  });
});

describe("missing column notes", () => {
  it("uses the mapping form's labels", () => {
    expect(requiredColumnNote(["date", "netWorth"], FIELDS["progress-snapshots"])).toBe(
      "Required: choose a column for Date and Net worth.",
    );
    expect(requiredColumnNote(["account", "balance"], FIELDS["account-balances"])).toBe(
      "Required: choose a column for Account name and Balance.",
    );
    expect(requiredColumnNote(["date", "amount"], FIELDS.transactions)).toBe(
      "Required: choose a column for Date and Amount (signed).",
    );
    expect(requiredColumnNote([], FIELDS["progress-snapshots"])).toBe("Required: choose a column.");
  });

  it("does not show the csv:columns parser text on net-worth history", async () => {
    stubFetch();
    await openCsvTab();
    fireEvent.click(screen.getByRole("radio", { name: /Net-worth history/ }));
    chooseFile("bad.csv", "foo,bar\nalpha,beta\n");
    expect(
      await screen.findByText("Required: choose a column for Date and Net worth."),
    ).toBeTruthy();
    expect(screen.getAllByText("Required: choose a column").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("csv:columns");
    expect(document.body.textContent).not.toContain("Map them with");
    expect(document.body.textContent).not.toContain("netWorth");
  });
});
