/**
 * Import worker-thread entry (`import-pool.ts`). Long-lived: runs one import task per message and answers
 * `{ id, ok, result | error }`. Uses the real importers; tests that inject fakes run tasks in-process instead.
 */
import { parentPort } from "node:worker_threads";
import { importDeps } from "../deps.js";
import { type ImportTask, runImportTask, serializeImportError } from "./import-task.js";

const port = parentPort;
if (!port) throw new Error("import-worker must run in a worker thread");

port.on("message", (m: { id: number; task: ImportTask }) => {
  let reply: { id: number; ok: boolean; result?: unknown; error?: unknown };
  try {
    reply = { id: m.id, ok: true, result: runImportTask(m.task, importDeps) };
  } catch (err) {
    reply = { id: m.id, ok: false, error: serializeImportError(err) };
  }
  try {
    port.postMessage(reply);
  } catch (err) {
    // A result that cannot be cloned: say so instead of leaving the request waiting for the time limit.
    port.postMessage({ id: m.id, ok: false, error: serializeImportError(err) });
  }
});

port.postMessage({ ready: true });
