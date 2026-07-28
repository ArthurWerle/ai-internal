import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { runGenerateUiAgent } from "../../graph/generate_ui_agent.ts";
import { buildUiHistory } from "../../services/chat_history.ts";
import type { OpenRouterService } from "../../services/open_router.ts";
import type { GeneratedUiSummary } from "../../services/generated_uis.ts";
import { config } from "../../config/config.ts";

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Short, chat-style label for a generated UI, shown in the rewind menu. Runs on
// the cheap default model (config.models — the same one used for chat titles).
// Best-effort: any failure falls back to a trimmed version of the question so
// the UI still gets a usable label.
const TITLE_SYSTEM_PROMPT = JSON.stringify({
  role: 'You label generated UI pages.',
  task: "Given the user's request for a page, produce a very short title (at most 6 words) describing the page, in the same language as the request.",
  rules: [
    'Return ONLY the title text — no surrounding quotes, no trailing punctuation, no prefixes like "Title:".',
    'Keep it concise and specific (e.g. "Painel de gastos mensais", "Resumo por categoria").',
  ],
});

async function buildUiTitle(client: OpenRouterService, question: string): Promise<string> {
  const fallback = question.trim().slice(0, 80);
  try {
    const result = await client.generateText(TITLE_SYSTEM_PROMPT, question, {
      tags: ['generate-ui', 'title'],
    });
    if (!result.success || !result.data) return fallback;
    const title = result.data.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    return title ? title.slice(0, 80) : fallback;
  } catch {
    return fallback;
  }
}

// Display label for a history entry: the LLM title if present, else a trimmed
// question, else a neutral placeholder (covers rows created before titles).
function displayTitle(ui: GeneratedUiSummary): string {
  const title = (ui.metadata as Record<string, unknown> | null)?.title;
  if (typeof title === 'string' && title.trim()) return title.trim();
  if (ui.question && ui.question.trim()) return ui.question.trim().slice(0, 80);
  return 'UI sem título';
}

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
          },
          origin: {
            type: 'string',
            description: 'Calling service that owns this chat (defaults to "uiless-financer")'
          }
        }
      }
    },
  }, async (request, reply) => {
    const { question, userId, sessionId, chatId, origin } = request.body as {
      question: string;
      userId?: string;
      sessionId?: string;
      chatId?: string;
      origin?: string;
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
      : await fastify.chatsService.createChat({ userId, origin: origin ?? "uiless-financer" });

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

      // A short label so this page can be recognized in the rewind menu later.
      const title = await buildUiTitle(fastify.openRouterClient, question);

      await fastify.generatedUisService.saveEnabled({
        userId,
        question,
        html: result.html,
        metadata: {
          title,
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

  // Lists a user's previously generated UIs (most recent first) for the rewind
  // menu. Returns lightweight JSON metadata only — never the html payload — so
  // the menu stays cheap to load. The full page is fetched on selection below.
  fastify.get("/generated-uis", {
    schema: {
      querystring: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: {
            type: 'string',
            minLength: 1,
            description: 'User whose generated UIs should be listed'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            description: 'Max number of entries to return (default 20)'
          }
        }
      }
    },
  }, async (request) => {
    const { userId, limit } = request.query as { userId: string; limit?: number };

    const uis = await fastify.generatedUisService.listByUser(userId, { limit });

    const data = uis.map((ui) => {
      const chatId = (ui.metadata as Record<string, unknown> | null)?.chatId;
      return {
        id: ui.id,
        title: displayTitle(ui),
        question: ui.question,
        chatId: typeof chatId === 'string' ? chatId : null,
        enabled: ui.enabled,
        createdAt: ui.createdAt,
      };
    });

    return { success: true, data };
  });

  // Rewind: make a previously generated UI the user's enabled one and return it
  // as a renderable HTML page (with X-Chat-Id so the frontend can keep refining
  // it in the same conversation). Mirrors GET /generated-ui's response shape.
  fastify.post("/generated-ui/:id/enable", {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } }
      },
      body: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: {
            type: 'string',
            minLength: 1,
            description: 'User the UI must belong to'
          }
        }
      }
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { userId } = request.body as { userId: string };

    const ui = await fastify.generatedUisService.setEnabledById(userId, id);
    if (!ui) {
      reply.code(404).type('text/html; charset=utf-8');
      return errorPage('UI not found for this user.');
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
