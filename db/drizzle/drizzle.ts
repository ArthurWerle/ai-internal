import { Database } from "../db.ts";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg"
import { EmptyRelations } from "drizzle-orm/relations";

export class Drizzle extends Database {
    override init(): NodePgDatabase<EmptyRelations> & {
        $client: Pool;
    } {
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL!,
        });

        const db = drizzle({ client: pool });
        this.instance = db

        return db
    }
}

