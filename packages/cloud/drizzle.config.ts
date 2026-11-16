import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/control/schema.ts",
  out: "./drizzle",
});
