import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { buildGenerateUiGraph } from "../../graph/generate_ui_graph.ts";
import { config } from "../../config/config.ts";

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const errorPage = (message: string) => `<!DOCTYPE html>
<html>
<head><title>Something went wrong</title></head>
<body style="font-family: sans-serif; padding: 2rem;">
  <h1>Something went wrong</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;

async function routes(fastify: FastifyInstance) {
  fastify.post("/generate-ui", {
    schema: {
      body: {
        type: 'object',
        required: ['question'],
        properties: {
          question: {
            type: 'string',
            minLength: 1,
            description: 'Natural-language question, optionally including design/style instructions'
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
  }, async (request, reply) => {
    const { question, userId, sessionId } = request.body as {
      question: string;
      userId?: string;
      sessionId?: string;
    };

    const graph = buildGenerateUiGraph(fastify.openRouterClient, fastify.mcpClient);
    const result = await graph.invoke({
      messages: [new HumanMessage(question)],
      userId,
      sessionId,
    });

    if (!result.html) {
      reply.code(500).type('text/html; charset=utf-8');
      return errorPage(result.error ?? 'Could not generate the page.');
    }

    // Persist the generated page as this user's single enabled UI. Only possible
    // when a userId is provided; never let a persistence failure break the
    // response — the caller still gets the freshly generated HTML.
    if (userId) {
      try {
        await fastify.generatedUisService.saveEnabled({
          userId,
          question,
          html: result.html,
          metadata: {
            model: config.uiGenerationModel,
            sessionId,
            generatedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        fastify.log.error({ err: error, userId }, 'Failed to persist generated UI');
      }
    }

    reply.type('text/html; charset=utf-8');
    return result.html;
  });

  // Returns the single enabled UI for a user, as a renderable HTML page.
  fastify.get("/generated-ui", {
    schema: {
      querystring: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: {
            type: 'string',
            minLength: 1,
            description: 'User whose enabled UI should be returned'
          }
        }
      }
    },
  }, async (request, reply) => {
    const { userId } = request.query as { userId: string };

    const ui = await fastify.generatedUisService.getEnabled(userId);
    if (!ui) {
      reply.code(404).type('text/html; charset=utf-8');
      return errorPage('No enabled UI found for this user yet.');
    }

    reply.type('text/html; charset=utf-8');
    return ui.html;
  });
}

export default routes;
