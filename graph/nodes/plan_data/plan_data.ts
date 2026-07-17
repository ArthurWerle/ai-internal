import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import type { GenerateUiState } from "../../generate_ui_graph.ts";
import { PROMPTS } from './prompts.ts';

const ToolNameSchema = z.enum([
    'list_categories',
    'list_subcategories',
    'list_locations',
    'list_transactions',
    'get_transaction',
    'get_latest_transactions',
    'get_biggest_transactions',
    'get_average_by_type',
    'get_average_by_category',
]);

export const PlannedCallSchema = z.object({
    tool: ToolNameSchema,
    category: z.string().optional(),
    query: z.string().optional(),
    type: z.enum(['income', 'expense']).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    limit: z.number().optional(),
    offset: z.number().optional(),
    id: z.union([z.string(), z.number()]).optional(),
    month: z.number().optional(),
    year: z.number().optional(),
    category_id: z.number().optional(),
});

export type PlannedCall = z.infer<typeof PlannedCallSchema>;

const DataPlanSchema = z.object({
    calls: z.array(PlannedCallSchema).min(1).max(5)
        .describe('The tool calls needed to gather all data for the page'),
});

export function createPlanDataNode(llmClient: OpenRouterService) {
    return async (state: GenerateUiState): Promise<Partial<GenerateUiState>> => {
        console.log('🗺️  Planning data queries...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { error: 'No messages in state.' };
        }

        try {
            const plan = await llmClient.generateStructured(
                PROMPTS.getSystemPrompt(),
                lastMessage,
                DataPlanSchema,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['generate-ui', 'plan-data'],
                },
            );

            if (!plan.success) {
                console.warn('⚠️  Data planning failed:', plan.error);
                return { error: plan.error };
            }

            const calls = plan.data!.calls;
            console.log(`✅ Planned ${calls.length} call(s): ${calls.map((call) => call.tool).join(', ')}`);
            return { plannedCalls: calls };
        } catch (error) {
            console.error('❌ Error in planData node:', error);
            return {
                error: error instanceof Error ? error.message : 'Data planning failed',
            };
        }
    };
}
