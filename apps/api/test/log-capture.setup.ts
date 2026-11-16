/** Installs the capturing logger for every API test file and checks what was logged (T-LOG). */
import { afterAll } from "vitest";
import { createLogger, setLogger } from "../src/log.js";
import { captured, captureLine, logProblems } from "./log-capture.js";

setLogger(createLogger({ level: "debug", sink: captureLine }));

afterAll(() => {
  const problems = logProblems(captured);
  captured.length = 0;
  if (problems.length)
    throw new Error(`T-LOG: forbidden data in log lines:\n${[...new Set(problems)].join("\n")}`);
});
