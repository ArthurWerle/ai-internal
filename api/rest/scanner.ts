import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { buildReceiptScannerGraph } from "../../graph/receipt_scanner.ts";
import { buildMultimodalContentParts, type MessagePart } from "../../lib/multimodal_message.ts";

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

        const contentParts = buildMultimodalContentParts(messages);

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
