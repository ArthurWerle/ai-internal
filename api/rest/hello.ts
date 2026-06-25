import type { FastifyInstance } from "npm:fastify";

async function routes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    return { hello: "world" };
  });
}

export default routes;
