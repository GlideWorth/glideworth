// Copies SQL migrations next to the compiled server so `node dist/server.js` can migrate.
import { cpSync } from "node:fs";

cpSync(new URL("../drizzle", import.meta.url), new URL("../dist/drizzle", import.meta.url), {
  recursive: true,
});
