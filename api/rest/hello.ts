import { FastifyInstance } from "fastify/types/instance";

async function routes(fastify: FastifyInstance) {
  fastify.get("/", async (request, reply) => {
    return { hello: "world" };
  });
}

export default routes;
