import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": root,
      // The marker package throws outside React Server Components; tests are server code.
      "server-only": path.join(root, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-env.ts"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, ".next/**", "e2e/**", "**/*.db.test.ts"],
        },
      },
      {
        // Needs a MongoDB replica set: TEST_MONGODB_URI, or a throwaway in-memory one (tests/db-setup.ts).
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.test.ts"],
          exclude: [...configDefaults.exclude, ".next/**", "e2e/**"],
          globalSetup: ["./tests/db-setup.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
