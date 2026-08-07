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
 *  1. If POSTGRES_HOST is set (compose sets it to the `postgres` service name)
 *     along with POSTGRES_USER + POSTGRES_DB, build from the discrete vars and
 *     ignore DATABASE_URL. In the compose network those vars are authoritative,
 *     so a stray DATABASE_URL (e.g. a local one pointing at localhost:5439) can
 *     never override the in-network connection.
 *  2. Otherwise (e.g. local dev, no POSTGRES_HOST): DATABASE_URL, if set and it
 *     includes a non-empty database name.
 *  3. Otherwise: build from POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB with
 *     a default host of "postgres" and port "5432".
 *
 * Throws with an actionable message if none of the above is usable.
 */
export function resolveDatabaseUrl(): string {
  const user = process.env.POSTGRES_USER;
  const password = process.env.POSTGRES_PASSWORD ?? "";
  const database = process.env.POSTGRES_DB;
  const host = process.env.POSTGRES_HOST;
  const port = process.env.POSTGRES_PORT ?? "5432";

  const buildFrom = (h: string) => {
    const auth = `${encodeURIComponent(user!)}:${encodeURIComponent(password)}`;
    return `postgres://${auth}@${h}:${port}/${encodeURIComponent(database!)}`;
  };

  // 1. In the compose network POSTGRES_HOST is set; discrete vars win.
  if (host && user && database) {
    return buildFrom(host);
  }

  // 2. Outside compose, an explicit DATABASE_URL (with a db name) takes over.
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl && hasDatabaseSegment(databaseUrl)) {
    return databaseUrl;
  }

  // 3. Fall back to the discrete vars with a default host.
  if (user && database) {
    return buildFrom(host ?? "postgres");
  }

  throw new Error(
    "Cannot resolve a Postgres connection: set DATABASE_URL (including a " +
      "database name), or set POSTGRES_USER and POSTGRES_DB (plus " +
      "POSTGRES_PASSWORD / POSTGRES_HOST / POSTGRES_PORT as needed).",
  );
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
