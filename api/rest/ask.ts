import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod/v3";
import { runAskAgent } from "../../graph/ask_agent.ts";
import { buildMultimodalContentParts, type MessagePart } from "../../lib/multimodal_message.ts";
import { toBaseMessages } from "../../services/chat_history.ts";
import type { NewAttachment } from "../../services/chats.ts";

const ChatTitleSchema = z.object({
  title: z.string().describe("A short, concise 3-6 word title summarizing this conversation"),
});

async function routes(fastify: FastifyInstance) {
  fastify.post("/ask", {
    schema: {
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          messages: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['type', 'content'],
              properties: {
                type: { type: 'string', enum: ['text', 'image', 'audio'] },
                content: { type: 'string' },
              },
            },
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
            description: 'Optional chat ID to continue an existing conversation'
          }
        }
      }
    },
  }, async (request, reply) => {
    const { messages, userId, sessionId, chatId } = request.body as {
      messages: MessagePart[];
      userId?: string;
      sessionId?: string;
      chatId?: string;
    };

    const isNewChat = !chatId;
    const chat = chatId
      ? await fastify.chatsService.getChat(chatId)
      : await fastify.chatsService.createChat({ userId });

    if (!chat) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    const priorMessages = await fastify.chatsService.listMessages(chat.id);
    const history = toBaseMessages(priorMessages);

    const textContent = messages
      .filter((message): message is Extract<MessagePart, { type: 'text' }> => message.type === 'text')
      .map((message) => message.content)
      .join('\n\n');
    const attachments: NewAttachment[] = messages
      .filter((message): message is Extract<MessagePart, { type: 'image' | 'audio' }> =>
        message.type === 'image' || message.type === 'audio')
      .map((message) => ({ type: message.type, content: message.content }));

    await fastify.chatsService.addMessage({
      chatId: chat.id,
      role: "user",
      content: textContent,
      attachments,
    });

    const contentParts = buildMultimodalContentParts(messages);
    const humanMessage = new HumanMessage({ content: contentParts });

    const [result, titleResult] = await Promise.all([
      runAskAgent(fastify.openRouterClient, fastify.mcpClient, {
        messages: [...history, humanMessage],
        userId,
        sessionId: sessionId ?? chat.id,
      }),
      isNewChat && textContent
        ? fastify.openRouterClient.generateStructured(
            "Generate a short title for this conversation.",
            textContent,
            ChatTitleSchema,
            { tags: ['ask-endpoint', 'chat-title'] },
          )
        : Promise.resolve(null),
    ]);

    if (titleResult?.success && titleResult.data) {
      await fastify.chatsService.updateChat(chat.id, { title: titleResult.data.title });
    }

    if (result.answer) {
      await fastify.chatsService.addMessage({
        chatId: chat.id,
        role: "assistant",
        content: result.answer,
        metadata: {
          intent: "agent",
          toolsUsed: result.toolsUsed,
          // Persisted so a follow-up turn (e.g. answering "qual seria a
          // location?") can update the exact transactions this turn created.
          ...(result.createdTransactionIds.length > 0
            ? { createdTransactionIds: result.createdTransactionIds }
            : {}),
        },
      });
    }

    return {
      success: true,
      chatId: chat.id,
      intent: "agent",
      answer: result.answer,
      toolsUsed: result.toolsUsed,
    };
  });
}

export default routes;
