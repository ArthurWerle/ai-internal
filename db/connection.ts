// Resolves the Postgres connection string used by both the migration step
// (db/drizzle/migrate.ts) and the app pool (db/drizzle/drizzle.ts).
//
// Historically the connection string came only from DATABASE_URL, which
// docker-compose built via `${...}` interpolation. Compose interpolation reads
// from the host shell / a `.env` file — NOT from `env_file: stack.env` — so when
// those vars were missing on the host, DATABASE_URL collapsed to
// `postgres://:@postgres:5432/` and libpq fell back to the username as the
// database name, producing `database "..." does not exist`.
//
// To avoid that, we treat the discrete POSTGRES_* vars (injected into the
// container via env_file, always present) as the source of truth, and only use
// DATABASE_URL when it is a complete, usable URL (e.g. local dev pointing at
// localhost).

function hasDatabaseSegment(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    // pathname is "/" (empty db) when the URL has no database segment.
    return url.pathname.replace(/^\//, "").length > 0;
  } catch {
    return false;
  }
}

/**
 * Returns a Postgres connection string.
 *
 * Preference order:
 *  1. DATABASE_URL, if set and it includes a non-empty database name.
 *  2. A URL built from POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB, with
 *     POSTGRES_HOST (default "postgres", the compose service name) and
 *     POSTGRES_PORT (default "5432").
 *
 * Throws with an actionable message if neither source is usable.
 */
export function resolveDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && hasDatabaseSegment(databaseUrl)) {
    return databaseUrl;
  }

  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD ?? "";
  const database = process.env.POSTGRES_DB;
  const host = process.env.POSTGRES_HOST ?? "postgres";
  const port = process.env.POSTGRES_PORT ?? "5432";

  if (!user || !database) {
    throw new Error(
      "Cannot resolve a Postgres connection: set DATABASE_URL (including a " +
        "database name), or set POSTGRES_USER and POSTGRES_DB (plus " +
        "POSTGRES_PASSWORD / POSTGRES_HOST / POSTGRES_PORT as needed).",
    );
  }

  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
}

/**
 * Given a connection string, returns the target database name and an admin
 * connection string pointing at the `postgres` maintenance database (same host,
 * port and credentials). Used to create the target database if it is missing.
 */
export function adminConnection(
  connectionString: string,
): { databaseName: string; adminUrl: string } {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  url.pathname = "/postgres";
  return { databaseName, adminUrl: url.toString() };
}
