import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { buildReceiptScannerGraph } from "../../graph/receipt_scanner.ts";

type MessagePart =
    | { type: 'text'; content: string }
    | { type: 'image'; content: string }   // base64-encoded
    | { type: 'audio'; content: string };  // base64-encoded

async function routes(fastify: FastifyInstance) {
    fastify.post('/scan', {
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
                    userId: { type: 'string' },
                    sessionId: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { messages, userId, sessionId } = request.body as {
            messages: MessagePart[];
            userId?: string;
            sessionId?: string;
        };

        const contentParts = messages.map(msg => {
            if (msg.type === 'text') {
                return { type: 'text' as const, text: msg.content };
            }
            if (msg.type === 'image') {
                return {
                    type: 'image_url' as const,
                    image_url: { url: `data:image/jpeg;base64,${msg.content}` },
                };
            }
            // audio — passed as input_audio; model support depends on OpenRouter provider
            return {
                type: 'input_audio' as const,
                input_audio: { data: msg.content, format: 'mp3' },
            };
        });

        const humanMessage = new HumanMessage({ content: contentParts });

        const graph = buildReceiptScannerGraph(
            fastify.openRouterClient,
            fastify.mcpClient,
        );

        const result = await graph.invoke({
            messages: [humanMessage],
        });

        if (result.error) {
            reply.code(422);
            return { success: false, error: result.error };
        }

        return {
            success: true,
            summary: result.summary,
            transactions: result.createdTransactions,
        };
    });
}

export default routes;
