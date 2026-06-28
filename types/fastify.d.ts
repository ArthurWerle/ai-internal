import type { NodePgDatabase } from "drizzle-orm/node-postgres";

declare module "fastify" {
  interface FastifyInstance {
    db: NodePgDatabase<any>;
  }
}
