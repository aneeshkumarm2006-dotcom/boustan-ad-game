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

/** The connection string for scripts: the admin user when set (migrations need it). */
export function scriptDatabaseUrl(): string {
  const url = process.env.MONGODB_URI_MIGRATIONS || process.env.MONGODB_URI;
  if (!url) {
    console.error("Set MONGODB_URI (or MONGODB_URI_MIGRATIONS) in .env.local or the shell.");
    process.exit(1);
  }
  return url;
}

/** A connection string with the credentials hidden, for messages. */
export function describeUrl(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//***@");
}

export function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
