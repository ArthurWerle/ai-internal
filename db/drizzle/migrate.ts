import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";

// Resolve the migrations folder relative to this file so it works regardless of cwd.
const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new Pool({ connectionString });

  // On deploy the database may still be starting up, so wait for it to accept connections.
  const maxAttempts = 10;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (err) {
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
