import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { GraphState } from "../../receipt_scanner.ts";
import { PROMPTS } from './prompts.ts'

export const ItemSchema = z.object({
    category: z.string().describe('The category name'),
    categoryId: z.number().describe('ID of the category'),
    subcategory: z.string().optional().describe('Sub category name'),
    subcategoryId: z.number().optional().describe('ID of the subcategory'),
    datetime: z.string().describe('Transaction date and time in ISO format'),
    value: z.number().describe('Exact amount of that one item'),
    description: z.string().describe('Description of the item'),
    location: z.string().optional().describe('Where the transaction was made')
})

export const ResponseSchema = z.object({
    items: z.array(ItemSchema),
  
});

export function createIdentifyMessageNode(llmClient: OpenRouterService) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        console.log(`🔍 Identifying message...`);
        const input = state.messages.at(-1)!.text;

        try {
            const systemPrompt = PROMPTS.getSystemPrompt([], [], [])
            const userPrompt = PROMPTS.getUserPromptTemplate(input)
            const result = await llmClient.generateStructured(
                systemPrompt,
                userPrompt,
                ResponseSchema
            )

            if(!result.success){
                console.log(`⚠️  Identfy Message failed: ${result.error}`);
                return {
                    error: result.error
                }
            }

            const intentData = result.data!
            console.log(`✅ Message identified`);

            return {
                ...intentData,
            };

        } catch (error) {
            console.error('❌ Error in IdentifyMessageNode node:', error);
            return {
                ...state,
                error: error instanceof Error ? error.message : 'Intent identification failed',
            };
        }
    }
}