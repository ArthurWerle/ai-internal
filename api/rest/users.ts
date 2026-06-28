import type { FastifyInstance } from "fastify";
import { usersTable } from "../../db/drizzle/schema.ts";

async function routes(fastify: FastifyInstance) {
  fastify.get("/users", async (request, reply) => {
    const users = await fastify.db.select().from(usersTable);
    return { users };
  });
}

export default routes;
