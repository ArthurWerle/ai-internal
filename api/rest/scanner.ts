import type { FastifyInstance } from "fastify";
import { HumanMessage } from "@langchain/core/messages";
import { buildReceiptScannerGraph } from "../../graph/receipt_scanner.ts";
import { buildMultimodalContentParts, type MessagePart } from "../../lib/multimodal_message.ts";

// A previously-extracted item, sent back by the review UI so a correction turn
// can edit the existing proposal instead of re-parsing the image. Shape mirrors
// the graph's ExtractedItemSchema; kept loose since it only feeds a prompt.
type PreviousItem = {
    categoryId?: number;
    subcategoryId?: number;
    datetime?: string;
    value?: number;
    type?: 'income' | 'expense';
    description?: string;
    location?: string;
};

// Builds the human message for a correction turn: the previous proposal plus the
// user's instruction, as a single text part (no image). Corrections are surgical
// edits ("change the coffee's category to Leisure"), so re-running vision would be
// wasteful and could silently reshuffle items the user didn't mention.
function buildCorrectionParts(previousItems: PreviousItem[], messages: MessagePart[]) {
    const correction = messages
        .filter(part => part.type === 'text')
        .map(part => part.content)
        .join('\n')
        .trim();

    const payload = JSON.stringify({
        instruction:
            'The following items were previously extracted from a receipt. Apply the user_correction and return the FULL updated list of items. Remap any category/subcategory/location names to their IDs from the provided lists. Leave every item the correction does not mention unchanged.',
        previously_extracted_items: previousItems,
        user_correction: correction,
    });

    return buildMultimodalContentParts([{ type: 'text', content: payload }]);
}

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
                    // Propose-only: extract + validate but do NOT create. The caller
                    // reviews `items` and confirms separately.
                    dryRun: { type: 'boolean' },
                    // A correction turn: the proposal the user is editing. When present
                    // the graph applies the correction (from the text message) to these
                    // items instead of parsing an image.
                    previousItems: { type: 'array' },
                },
            },
        },
    }, async (request, reply) => {
        const { messages, dryRun, previousItems } = request.body as {
            messages: MessagePart[];
            userId?: string;
            sessionId?: string;
            dryRun?: boolean;
            previousItems?: PreviousItem[];
        };

        const contentParts = previousItems && previousItems.length > 0
            ? buildCorrectionParts(previousItems, messages)
            : buildMultimodalContentParts(messages);

        const humanMessage = new HumanMessage({ content: contentParts });

        const graph = buildReceiptScannerGraph(
            fastify.openRouterClient,
            fastify.mcpClient,
        );

        const result = await graph.invoke({
            messages: [humanMessage],
            dryRun,
        });

        if (result.error) {
            reply.code(422);
            return { success: false, error: result.error };
        }

        // The classifier was unsure what the purchase is (e.g. it could not tell
        // whether this is a supermarket receipt). Nothing was created — return
        // the question so the caller can ask the user and re-scan with an answer.
        if (result.needsClarification) {
            return {
                success: true,
                needsClarification: true,
                question: result.clarificationQuestion,
                items: result.items,
            };
        }

        // Propose-only: return the extracted items for review. Nothing was created
        // (the graph stops before createTransactions when dryRun is set).
        if (dryRun) {
            return {
                success: true,
                dryRun: true,
                items: result.items,
            };
        }

        return {
            success: true,
            summary: result.summary,
            transactions: result.createdTransactions,
        };
    });
}

export default routes;
