import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { runGenerateUiAgent } from "../../graph/generate_ui_agent.ts";
import { buildUiHistory } from "../../services/chat_history.ts";
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
          },
          chatId: {
            type: 'string',
            description: 'Optional chat ID to continue an existing UI conversation (so follow-ups like "make the title green" refine the previous page)'
          }
        }
      }
    },
  }, async (request, reply) => {
    const { question, userId, sessionId, chatId } = request.body as {
      question: string;
      userId?: string;
      sessionId?: string;
      chatId?: string;
    };

    // Anonymous callers get a stateless one-shot: no conversation, no
    // persistence — the agent still fetches its own data via the tools.
    if (!userId) {
      const result = await runGenerateUiAgent(fastify.openRouterClient, fastify.mcpClient, {
        messages: [new HumanMessage(question)],
        sessionId,
      });
      if (!result.html) {
        reply.code(500).type('text/html; charset=utf-8');
        return errorPage(result.error ?? 'Could not generate the page.');
      }
      reply.type('text/html; charset=utf-8');
      return result.html;
    }

    // Continue an existing conversation (when a chatId is supplied) or start a
    // new one, so follow-up requests can refine the previously generated page.
    const chat = chatId
      ? await fastify.chatsService.getChat(chatId)
      : await fastify.chatsService.createChat({ userId });

    if (!chat) {
      reply.code(404).type('text/html; charset=utf-8');
      return errorPage('Conversation not found.');
    }

    // Load history BEFORE recording this turn (mirrors /ask), then compact it so
    // only the most recent page's HTML is replayed in full.
    const priorMessages = await fastify.chatsService.listMessages(chat.id);
    const history = buildUiHistory(priorMessages);

    await fastify.chatsService.addMessage({
      chatId: chat.id,
      role: "user",
      content: question,
    });

    const result = await runGenerateUiAgent(fastify.openRouterClient, fastify.mcpClient, {
      messages: [...history, new HumanMessage(question)],
      userId,
      sessionId: sessionId ?? chat.id,
    });

    // Return the chat id so the frontend can send it back on the next request
    // and keep the conversation going.
    reply.header('X-Chat-Id', chat.id);

    if (!result.html) {
      reply.code(500).type('text/html; charset=utf-8');
      return errorPage(result.error ?? 'Could not generate the page.');
    }

    // Persist the generated page as the assistant turn (conversation memory) so
    // a follow-up can edit it, and as the user's single enabled UI (what loads
    // on next visit). Never let a persistence failure break the response.
    try {
      await fastify.chatsService.addMessage({
        chatId: chat.id,
        role: "assistant",
        content: result.html,
        metadata: { intent: "generate-ui", toolsUsed: result.toolsUsed },
      });

      await fastify.generatedUisService.saveEnabled({
        userId,
        question,
        html: result.html,
        metadata: {
          model: config.uiGenerationModel,
          sessionId,
          chatId: chat.id,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      fastify.log.error({ err: error, userId, chatId: chat.id }, 'Failed to persist generated UI');
    }

    reply.type('text/html; charset=utf-8');
    return result.html;
  });

  // Returns the single enabled UI for a user, as a renderable HTML page. Also
  // surfaces the chat id it was generated in (via X-Chat-Id) so a reloaded page
  // can keep refining it in the same conversation.
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

    const chatId = (ui.metadata as Record<string, unknown> | null)?.chatId;
    if (typeof chatId === 'string') {
      reply.header('X-Chat-Id', chatId);
    }

    reply.type('text/html; charset=utf-8');
    return ui.html;
  });
}

export default routes;
