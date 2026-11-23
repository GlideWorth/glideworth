/**
 * Goal seek trials field (issue #98). Typing used to clamp on each keystroke, so "5" became 100
 * and the next digit appended: "50" landed on 1000 and "100" on 2000. Backspace could not undo it.
 * The field now keeps the typed text until blur or Solve.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitGoalSeekTrials,
  GoalSeekSearchStatus,
  type GoalSeekTrialsHandle,
  GoalSeekTrialsField,
  goalSeekSearchLabel,
} from "../src/features/insights/goal-seek-controls";

const format = (n: number) => String(n);

afterEach(() => {
  cleanup();
});

/** Type over a selected field, appending each key to whatever the input is showing. */
function typeDigits(input: HTMLInputElement, digits: string) {
  let first = true;
  for (const ch of digits) {
    const base = first ? "" : input.value;
    first = false;
    fireEvent.change(input, { target: { value: base + ch } });
  }
}

function Harness({ onSolve }: { onSolve: (n: number) => void }) {
  const ref = useRef<GoalSeekTrialsHandle>(null);
  const [value, setValue] = useState(300);
  return (
    <>
      <GoalSeekTrialsField ref={ref} value={value} onCommit={setValue} format={format} />
      <button type="button" onClick={() => onSolve(ref.current!.commit())}>
        Solve
      </button>
      <output>{value}</output>
    </>
  );
}

describe("commitGoalSeekTrials", () => {
  it("keeps an in-range integer and clamps outside the range", () => {
    expect(commitGoalSeekTrials("100", 300)).toEqual({ value: 100, adjusted: null });
    expect(commitGoalSeekTrials("50", 300)).toEqual({ value: 100, adjusted: "min" });
    expect(commitGoalSeekTrials("2500", 300)).toEqual({ value: 2000, adjusted: "max" });
    expect(commitGoalSeekTrials("", 400)).toEqual({ value: 400, adjusted: null });
    expect(commitGoalSeekTrials("12a", 300)).toEqual({ value: 300, adjusted: null });
  });
});

describe("goal seek trials field", () => {
  it("lets 50 and 100 be typed, instead of jumping to 1000 and 2000", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;

    typeDigits(input, "50");
    expect(input.value).toBe("50");

    typeDigits(input, "100");
    expect(input.value).toBe("100");
  });

  it("lets backspace reduce 1000", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1000" } });
    expect(input.value).toBe("1000");
    fireEvent.change(input, { target: { value: input.value.slice(0, -1) } });
    expect(input.value).toBe("100");
  });

  it("clamps on blur and says which bound it hit", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;

    typeDigits(input, "50");
    fireEvent.blur(input);
    expect(input.value).toBe("100");
    expect(screen.getByText(/Raised to 100, the minimum/)).toBeTruthy();
    // A controlled update can report the value we just wrote. That is not a new edit.
    fireEvent.change(input, { target: { value: "100" } });
    expect(screen.getByText(/Raised to 100, the minimum/)).toBeTruthy();

    typeDigits(input, "5000");
    fireEvent.blur(input);
    expect(input.value).toBe("2000");
    expect(screen.getByText(/Lowered to 2000, the maximum/)).toBeTruthy();
    expect(screen.getByText(/few minutes/)).toBeTruthy();
  });

  it("keeps a cleared field until blur, then restores the last committed value", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;
    typeDigits(input, "400");
    fireEvent.blur(input);
    expect(input.value).toBe("400");
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.blur(input);
    expect(input.value).toBe("400");
  });

  it("uses the typed value when Solve is pressed before blur", () => {
    let solved = 0;
    render(<Harness onSolve={(n) => (solved = n)} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;
    typeDigits(input, "100");
    expect(input.value).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: "Solve" }));
    expect(solved).toBe(100);
    expect(input.value).toBe("100");
    expect(screen.getByRole("status").textContent).toBe("100");
  });

  it("keeps the clamp note when Solve blurs the field it just clamped", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;
    typeDigits(input, "50");
    fireEvent.click(screen.getByRole("button", { name: "Solve" }));
    expect(input.value).toBe("100");
    expect(screen.getByText(/Raised to 100, the minimum/)).toBeTruthy();
    fireEvent.blur(input);
    expect(input.value).toBe("100");
    expect(screen.getByText(/Raised to 100, the minimum/)).toBeTruthy();
  });

  it("warns that a high trial count is slow while it is still being typed", () => {
    render(<Harness onSolve={() => {}} />);
    const input = screen.getByLabelText("Trials per evaluation") as HTMLInputElement;
    typeDigits(input, "2000");
    expect(screen.getByText(/This many trials can take a few minutes/)).toBeTruthy();
  });
});

describe("goal seek search status", () => {
  it("describes a search that has not scored a candidate yet", () => {
    expect(goalSeekSearchLabel(0, 0, 0)).toBe("Starting the search…");
    expect(goalSeekSearchLabel(0, 40, 200)).toBe("Searching… evaluation 1");
    expect(goalSeekSearchLabel(13, 0, 0)).toBe("Searching… 13 evaluations so far");
    expect(goalSeekSearchLabel(1, 200, 200)).toBe("Searching… 1 evaluation so far");
  });

  it("shows a pending state, then trial progress inside the current evaluation", () => {
    const { rerender } = render(
      <GoalSeekSearchStatus evals={0} trialsDone={0} trialsTotal={0} format={format} />,
    );
    expect(screen.getByText("Starting the search…")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();

    rerender(<GoalSeekSearchStatus evals={3} trialsDone={40} trialsTotal={200} format={format} />);
    expect(screen.getByText("Searching… evaluation 4")).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: "Trials in this evaluation" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-valuemax")).toBe("200");
    expect(screen.getByText("40 of 200 trials in this evaluation")).toBeTruthy();
  });
});
