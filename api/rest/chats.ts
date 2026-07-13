import type { FastifyInstance } from "fastify";

async function routes(fastify: FastifyInstance) {
  fastify.get("/chats", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          userId: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
    },
  }, async (request) => {
    const { userId, limit, offset } = request.query as {
      userId?: string;
      limit?: number;
      offset?: number;
    };

    const data = await fastify.chatsService.listChats({ userId, limit, offset });
    return { success: true, data };
  });

  fastify.get("/chats/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const result = await fastify.chatsService.getChatWithMessages(id);
    if (!result) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    return { success: true, data: result };
  });

  fastify.post("/chats", {
    schema: {
      body: {
        type: "object",
        properties: {
          title: { type: "string" },
          userId: { type: "string" },
        },
      },
    },
  }, async (request) => {
    const { title, userId } = request.body as { title?: string; userId?: string };

    const data = await fastify.chatsService.createChat({ title, userId });
    return { success: true, data };
  });

  fastify.patch("/chats/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      body: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { title } = request.body as { title: string };

    const data = await fastify.chatsService.updateChat(id, { title });
    if (!data) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    return { success: true, data };
  });

  fastify.delete("/chats/:id", {
    schema: {
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const deleted = await fastify.chatsService.deleteChat(id);
    if (!deleted) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    return { success: true, data: { deleted: true } };
  });
}

export default routes;
