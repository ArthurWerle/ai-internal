import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { adminConnection, resolveDatabaseUrl } from "../connection.ts";

// Resolve the migrations folder relative to this file so it works regardless of cwd.
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

// Node errno strings that mean the server isn't reachable *yet* (worth retrying).
const TRANSIENT_ERRNOS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
]);

function getCode(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

// 3D000 = invalid_catalog_name: the target database does not exist. Permanent
// on its own, but self-healable by creating the database.
function isMissingDatabase(err: unknown): boolean {
  return getCode(err) === "3D000";
}

// Retryable startup conditions: server not up yet, or still starting up.
function isTransient(err: unknown): boolean {
  const code = getCode(err);
  if (code === "57P03") return true; // cannot_connect_now (server is starting)
  if (code && TRANSIENT_ERRNOS.has(code)) return true;
  if (!code) {
    // Some socket-level failures arrive without a code.
    const msg = err instanceof Error ? err.message : String(err);
    return /connection terminated|timeout|socket hang up/i.test(msg);
  }
  return false;
}

// Create the target database by connecting to the `postgres` maintenance
// database with the same credentials/host. Idempotent: a concurrent creator
// (42P04) is treated as success.
async function ensureDatabaseExists(connectionString: string): Promise<void> {
  const { databaseName, adminUrl } = adminConnection(connectionString);
  console.log(`Database "${databaseName}" does not exist; creating it...`);
  const admin = new Pool({ connectionString: adminUrl });
  try {
    // Identifiers can't be parameterized; quote and escape embedded quotes.
    const quoted = `"${databaseName.replace(/"/g, '""')}"`;
    await admin.query(`CREATE DATABASE ${quoted}`);
    console.log(`Database "${databaseName}" created.`);
  } catch (err) {
    if (getCode(err) === "42P04") {
      // duplicate_database: another process created it first — fine.
      console.log(`Database "${databaseName}" already exists.`);
    } else {
      throw err;
    }
  } finally {
    await admin.end();
  }
}

async function run() {
  const connectionString = resolveDatabaseUrl();
  const pool = new Pool({ connectionString });

  // On deploy the database may still be starting up, so wait for it to accept
  // connections. Distinguish transient startup errors (retry) from a missing
  // database (create it) and from permanent errors like bad auth (fail fast).
  const maxAttempts = 10;
  let createAttempted = false;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (err) {
      if (isMissingDatabase(err)) {
        if (createAttempted) throw err; // created it already; something else is wrong
        createAttempted = true;
        await ensureDatabaseExists(connectionString);
        continue; // reconnect to the now-existing database
      }
      if (!isTransient(err)) throw err; // e.g. 28P01 auth — retrying won't help
      if (attempt >= maxAttempts) throw err;
      const delayMs = Math.min(1000 * attempt, 5000);
      console.log(
        `Database not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const db = drizzle({ client: pool });

  console.log("Running database migrations...");
  await migrate(db, { migrationsFolder });
  console.log("Migrations complete.");

  await pool.end();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
