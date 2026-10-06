/** Loads .env.local (then .env) into process.env for CLI scripts; Next does this for the app. */
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(file);
    } catch {
      // Missing file: rely on the shell's environment.
    }
  }
}

/** The connection string for scripts: the session pooler when set (migrations need it). */
export function scriptDatabaseUrl(): string {
  const url = process.env.DATABASE_URL_MIGRATIONS || process.env.DATABASE_URL;
  if (!url) {
    console.error("Set DATABASE_URL (or DATABASE_URL_MIGRATIONS) in .env.local or the shell.");
    process.exit(1);
  }
  return url;
}

export function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
