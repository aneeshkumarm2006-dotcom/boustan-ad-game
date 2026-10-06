import { defineConfig } from "drizzle-kit";

// Migrations go through the session pooler (port 5432); the app uses the transaction pooler.
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATIONS || process.env.DATABASE_URL || "",
  },
  strict: true,
});
