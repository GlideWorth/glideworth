/**
 * The earliest-retirement answer is one sentence from the solver, rendered as plain text.
 * A one-month gap used to read "1 months later than planned".
 */
import { solveEarliestRetirement } from "@glideworth/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateText } from "../src/components/ui/private-text";
import { expense, makeInput } from "../../../packages/core/test/solvers-helpers";

afterEach(() => {
  cleanup();
});

describe("earliest-retirement solver message", () => {
  it("renders a one-month delay as '1 month later'", async () => {
    const input = makeInput({
      accounts: [{ id: "c", name: "Cash", type: "cash", owner: "me", balance: 0 }],
      plan: {
        milestones: [
          {
            id: "ret",
            name: "Retirement",
            kind: "retirement",
            personId: "me",
            criteria: [{ kind: "age", personId: "me", age: 58 + 7 / 12 }],
          },
        ],
        income: [
          {
            id: "sal",
            type: "salary",
            name: "Salary",
            owner: "me",
            amount: { value: 50_000 },
            frequency: "yearly",
            range: { start: { kind: "planStart" }, end: { kind: "milestone", milestoneId: "ret" } },
          },
        ],
        expenses: [expense("liv", 29_000)],
      },
      years: 20,
    });
    const r = await solveEarliestRetirement(input, {
      milestoneId: "ret",
      objective: { kind: "noShortfall" },
    });

    render(
      <p>
        <PrivateText>{r.explanation}</PrivateText>
      </p>,
    );

    expect(screen.getByText(/1 month later than planned/)).toBeTruthy();
    expect(screen.queryByText(/1 months/)).toBeNull();
  });
});
