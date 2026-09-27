import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./src/server/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://arham:arham@localhost:5439/arham" },
});
