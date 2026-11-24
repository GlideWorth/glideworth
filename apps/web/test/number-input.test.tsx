/** Money fields commit what was typed. "1e9" is one billion, never 19. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CurrencyInput } from "../src/components/ui/number-input";

afterEach(() => {
  cleanup();
});

function Field({ onValue }: { onValue: (v: number | null) => void }) {
  const [value, setValue] = useState<number | null>(19);
  return (
    <CurrencyInput
      aria-label="Amount"
      value={value}
      onValueChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe("CurrencyInput", () => {
  it("reads 1e9 as one billion and leaves junk uncommitted", () => {
    const seen: (number | null)[] = [];
    const qc = new QueryClient();
    qc.setQueryData(["workspace"], {
      doc: { household: { locale: "en-GB", currency: "GBP" }, settings: {} },
      source: "sample",
    });
    render(
      <QueryClientProvider client={qc}>
        <Field onValue={(v) => seen.push(v)} />
      </QueryClientProvider>,
    );
    const input = screen.getByLabelText("Amount");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1e9" } });
    fireEvent.blur(input);
    expect(seen).toContain(1_000_000_000);
    expect(seen).not.toContain(19);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1x9" } });
    fireEvent.blur(input);
    expect(seen.at(-1)).toBe(1_000_000_000);
  });
});
