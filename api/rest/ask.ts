import type { FastifyInstance } from "fastify";
import { z } from "zod/v3";

export const TestSchema = z.object({
    answer: z.string().describe("The answer to the prompt"),
  });

async function routes(fastify: FastifyInstance) {
  fastify.post("/ask", {
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description: 'The prompt to ask the assistant'
          },
          userId: {
            type: 'string',
            description: 'Optional user ID for tracking'
          },
          sessionId: {
            type: 'string',
            description: 'Optional session ID for grouping conversations'
          }
        }
      }
    },
  }, async (request) => {
    const { prompt, userId, sessionId } = request.body as {
      prompt: string;
      userId?: string;
      sessionId?: string;
    };

    // Generate a unique trace name for better observability
    const response = await fastify.openRouterClient.generateStructured(
      "You are a helpful assistant.",
      prompt,
      TestSchema,
      {
        userId,
        sessionId,
        tags: ['ask-endpoint', 'production'],
        metadata: {
          endpoint: '/ask',
          timestamp: new Date().toISOString(),
          promptLength: prompt.length,
        }
      }
    );

    return {
      success: response.success,
      data: response.data,
    };
  });
}



export default routes;
