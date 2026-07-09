import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { GraphState } from "../../receipt_scanner.ts";
import { PROMPTS } from './prompts.ts';

const ExtractedItemSchema = z.object({
    categoryId: z.number().optional().describe('ID of the matching category'),
    subcategoryId: z.number().optional().describe('ID of the matching subcategory'),
    datetime: z.string().describe('Transaction date and time in ISO format'),
    value: z.number().describe('Exact amount in BRL'),
    type: z.enum(['income', 'expense']).optional().describe('Transaction type — default to expense'),
    description: z.string().describe('Description of the item or purchase'),
    location: z.string().optional().describe('Where the transaction took place'),
});

const ResponseSchema = z.object({
    items: z.array(ExtractedItemSchema),
});

export function createIdentifyMessageNode(llmClient: OpenRouterService) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        console.log('🔍 Identifying message...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { error: 'No messages in state.' };
        }

        try {
            const systemPrompt = PROMPTS.getSystemPrompt(
                state.categories ?? [],
                state.subcategories ?? [],
                state.locations ?? [],
            );

            const result = await llmClient.generateStructured(
                systemPrompt,
                lastMessage,
                ResponseSchema,
            );

            if (!result.success) {
                console.warn('⚠️  Identify message failed:', result.error);
                return { error: result.error };
            }

            console.log(`✅ Extracted ${result.data!.items.length} item(s)`);
            return { items: result.data!.items };

        } catch (error) {
            console.error('❌ Error in identifyMessage node:', error);
            return {
                error: error instanceof Error ? error.message : 'Message identification failed',
            };
        }
    };
}
