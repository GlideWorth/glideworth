/** Worker-thread entry: runs one job and reports progress/result/error to the parent. */
import { parentPort, workerData } from "node:worker_threads";
import { coreDeps } from "../deps.js";
import { type JobSpec, runJob, serializeError } from "./run.js";

const controller = new AbortController();
const port = parentPort;
if (!port) throw new Error("worker.ts must run in a worker thread");

let last = 0;
runJob(
  workerData as JobSpec,
  {
    signal: controller.signal,
    onProgress: (value) => {
      const now = Date.now();
      if (now - last > 50 || value >= 1) {
        last = now;
        port.postMessage({ type: "progress", value });
      }
    },
  },
  coreDeps,
)
  .then((result) => port.postMessage({ type: "done", result }))
  .catch((err) => port.postMessage({ type: "error", error: serializeError(err) }));
