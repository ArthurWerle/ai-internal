import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod/v3";
import { runAskAgent, runAskAgentStream } from "../../graph/ask_agent.ts";
import { buildMultimodalContentParts, type MessagePart } from "../../lib/multimodal_message.ts";
import { toBaseMessages } from "../../services/chat_history.ts";
import type { NewAttachment } from "../../services/chats.ts";

const ChatTitleSchema = z.object({
  title: z.string().describe("A short, concise 3-6 word title summarizing this conversation"),
});

// Shared JSON body schema for /ask and /ask/stream — both take the same input.
const askBodySchema = {
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
    userId: { type: 'string', description: 'Optional user ID for tracking' },
    sessionId: { type: 'string', description: 'Optional session ID for grouping conversations' },
    chatId: { type: 'string', description: 'Optional chat ID to continue an existing conversation' },
    origin: { type: 'string', description: 'Calling service that owns this chat (defaults to "financer")' },
  },
} as const;

type AskBody = {
  messages: MessagePart[];
  userId?: string;
  sessionId?: string;
  chatId?: string;
  origin?: string;
};

// Splits the incoming parts into the text (joined) and the image/audio
// attachments, exactly as /ask persists them.
function splitMessageParts(messages: MessagePart[]): { textContent: string; attachments: NewAttachment[] } {
  const textContent = messages
    .filter((message): message is Extract<MessagePart, { type: 'text' }> => message.type === 'text')
    .map((message) => message.content)
    .join('\n\n');
  const attachments: NewAttachment[] = messages
    .filter((message): message is Extract<MessagePart, { type: 'image' | 'audio' }> =>
      message.type === 'image' || message.type === 'audio')
    .map((message) => ({ type: message.type, content: message.content }));
  return { textContent, attachments };
}

async function routes(fastify: FastifyInstance) {
  fastify.post("/ask", {
    schema: { body: askBodySchema },
  }, async (request, reply) => {
    const { messages, userId, sessionId, chatId, origin } = request.body as AskBody;

    const isNewChat = !chatId;
    const chat = chatId
      ? await fastify.chatsService.getChat(chatId)
      : await fastify.chatsService.createChat({ userId, origin: origin ?? "financer" });

    if (!chat) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    const priorMessages = await fastify.chatsService.listMessages(chat.id);
    const history = toBaseMessages(priorMessages);

    const { textContent, attachments } = splitMessageParts(messages);

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

    // Out of OpenRouter credits: surface the limit clearly instead of the
    // hardcoded success below. Returned before persistence so the limit notice
    // isn't written into chat history as if it were a real assistant answer.
    if (result.error === "insufficient_credits") {
      reply.code(402);
      return {
        success: false,
        chatId: chat.id,
        intent: "agent",
        error: "insufficient_credits",
        errorCode: "insufficient_credits",
        answer: result.answer,
        toolsUsed: [],
      };
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

  // Streaming twin of /ask. Same input and persistence, but the answer is sent
  // back over Server-Sent Events as it is produced: `token` frames as the model
  // writes, `tool_start`/`tool_end` frames as it calls tools, and a terminal
  // `done` frame carrying the same fields /ask returns (chatId, answer,
  // toolsUsed, and errorCode on the credit limit). The frontend renders this as
  // a live, ChatGPT-style reply with visible tool activity.
  fastify.post("/ask/stream", {
    schema: { body: askBodySchema },
  }, async (request, reply) => {
    const { messages, userId, sessionId, chatId, origin } = request.body as AskBody;

    const isNewChat = !chatId;
    const chat = chatId
      ? await fastify.chatsService.getChat(chatId)
      : await fastify.chatsService.createChat({ userId, origin: origin ?? "financer" });

    // No SSE has been written yet, so a missing chat is a normal JSON 404 the
    // caller can parse before switching into stream-reading mode.
    if (!chat) {
      reply.code(404);
      return { success: false, error: "Chat not found" };
    }

    const priorMessages = await fastify.chatsService.listMessages(chat.id);
    const history = toBaseMessages(priorMessages);

    const { textContent, attachments } = splitMessageParts(messages);

    await fastify.chatsService.addMessage({
      chatId: chat.id,
      role: "user",
      content: textContent,
      attachments,
    });

    const contentParts = buildMultimodalContentParts(messages);
    const humanMessage = new HumanMessage({ content: contentParts });

    // Title generation runs alongside the streamed answer; it's awaited just
    // before the `done` frame so the chat is renamed by the time the client
    // refreshes its chat list.
    const titlePromise = isNewChat && textContent
      ? fastify.openRouterClient.generateStructured(
          "Generate a short title for this conversation.",
          textContent,
          ChatTitleSchema,
          { tags: ['ask-endpoint', 'chat-title'] },
        )
      : Promise.resolve(null);

    // Abort the agent's model calls if the client drops the connection.
    const abortController = new AbortController();
    request.raw.on("close", () => abortController.abort());

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so frames flush to the client live.
      "X-Accel-Buffering": "no",
    });
    const send = (payload: unknown) => {
      // The client may have disconnected mid-stream (writableEnded/destroyed);
      // swallow the resulting write error instead of crashing the handler.
      if (raw.writableEnded || raw.destroyed) return;
      try {
        raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch {
        // Broken pipe — nothing more to do, the run is aborted via the signal.
      }
    };

    let result: Awaited<ReturnType<typeof runAskAgent>> | null = null;
    try {
      for await (const event of runAskAgentStream(
        fastify.openRouterClient,
        fastify.mcpClient,
        {
          messages: [...history, humanMessage],
          userId,
          sessionId: sessionId ?? chat.id,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "result") {
          result = event.result;
        } else {
          send(event);
        }
      }
    } catch (error) {
      request.log.error(error, "ask/stream agent run failed");
      send({
        type: "done",
        success: false,
        chatId: chat.id,
        intent: "agent",
        error: error instanceof Error ? error.message : String(error),
        answer: "",
        toolsUsed: [],
      });
      raw.end();
      return;
    }

    const titleResult = await titlePromise.catch(() => null);
    if (titleResult?.success && titleResult.data) {
      await fastify.chatsService.updateChat(chat.id, { title: titleResult.data.title });
    }

    // Out of OpenRouter credits: mirror /ask by NOT persisting the limit notice
    // as a real assistant answer, and flag it so the client shows the usage
    // toast instead of a normal reply.
    if (result?.error === "insufficient_credits") {
      send({
        type: "done",
        success: false,
        chatId: chat.id,
        intent: "agent",
        error: "insufficient_credits",
        errorCode: "insufficient_credits",
        answer: result.answer,
        toolsUsed: [],
      });
      raw.end();
      return;
    }

    if (result?.answer) {
      await fastify.chatsService.addMessage({
        chatId: chat.id,
        role: "assistant",
        content: result.answer,
        metadata: {
          intent: "agent",
          toolsUsed: result.toolsUsed,
          ...(result.createdTransactionIds.length > 0
            ? { createdTransactionIds: result.createdTransactionIds }
            : {}),
        },
      });
    }

    send({
      type: "done",
      success: true,
      chatId: chat.id,
      intent: "agent",
      answer: result?.answer ?? "",
      toolsUsed: result?.toolsUsed ?? [],
    });
    raw.end();
  });
}

export default routes;
