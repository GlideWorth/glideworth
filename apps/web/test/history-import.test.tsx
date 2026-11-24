/** The balance-history import dialog, driven like a user: paste, check formats, map, preview, import. */
import { createSampleDocument } from "@glideworth/core/samples";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HistoryImportDialog,
  type HistoryImportRequest,
} from "../src/features/progress/history-import-dialog";

afterEach(() => {
  cleanup();
});

function setup(
  onImport = vi.fn(async (r: HistoryImportRequest) => ({
    counts: r.plan.counts,
    currentBalances: false,
  })),
) {
  const doc = createSampleDocument();
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(["workspace"], { doc, source: "sample" });
  render(
    <QueryClientProvider client={qc}>
      <HistoryImportDialog open onOpenChange={() => {}} doc={doc} onImport={onImport} />
    </QueryClientProvider>,
  );
  return { onImport, doc };
}

const paste = (text: string) =>
  fireEvent.change(screen.getByLabelText("Paste cells from your spreadsheet"), {
    target: { value: text },
  });
const next = () => fireEvent.click(screen.getByRole("button", { name: "Continue" }));

describe("HistoryImportDialog", () => {
  it("walks from pasted cells to an import of the clean values", async () => {
    const { onImport } = setup();
    paste(
      "Date\tHigh-yield savings\tCar loan\tHoliday fund\n2024-01-31\t1,000\t-9,000\t5\n2024-02-29\t#N/A\t-8,800\t6\n",
    );
    expect(screen.getByRole("status").textContent).toContain("3 lines ready");
    next();
    expect(screen.getByText(/Read 2 dates and 3 columns/)).toBeTruthy();
    next();
    // Mapped by name; the unknown column is skipped.
    expect(screen.getByText(/2 of 3 columns mapped/)).toBeTruthy();
    next();
    // One flagged cell: the import waits until the user chooses to skip it.
    const importButton = () =>
      screen.getByRole("button", { name: /^Import \d+ change/ }) as HTMLButtonElement;
    expect(importButton().disabled).toBe(true);
    expect(screen.getByText(/1 flagged cell/)).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: /Import the clean cells/ }));
    expect(importButton().disabled).toBe(false);
    expect(importButton().textContent).toBe("Import 3 changes");
    fireEvent.click(importButton());
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const req = onImport.mock.calls[0]![0];
    expect(req.mode).toBe("merge");
    expect(req.rows).toEqual([
      { date: "2024-01-31", values: { "account:acc-cash": 1000, "debt:debt-car": 9000 } },
      { date: "2024-02-29", values: { "debt:debt-car": 8800 } },
    ]);
    await screen.findByText("Imported.");
  });

  it("will not continue past ambiguous dates until a format is chosen", () => {
    setup();
    paste("Date,High-yield savings\n01/02/2024,1\n01/03/2024,2\n01/04/2024,3\n");
    next();
    expect(screen.getByText(/Read 3 dates and 1 column\./)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("will not guess");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // One button per reading of the first date; the second is day-first (1 February).
    const readings = screen.getAllByRole("button", { name: /^01\/02\/2024 is/ });
    expect(readings).toHaveLength(2);
    fireEvent.click(readings[1]!);
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("will not continue while no column is mapped", () => {
    setup();
    paste("Date,Pot\n2024-01-31,10\n");
    next();
    next();
    expect(screen.getByText(/0 of 1 column mapped/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Map at least one column/)).toBeTruthy();
  });

  it("explains why a one-line file cannot continue", () => {
    setup();
    paste("foo,bar");
    const cont = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(screen.getByText(/header only/)).toBeTruthy();
  });
});
