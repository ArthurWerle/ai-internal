import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { GraphState } from "../../receipt_scanner.ts";

const SummarySchema = z.object({
    summary: z.string().describe('Human-friendly summary of what was created'),
});

const SYSTEM_PROMPT = JSON.stringify({
    role: 'Financial assistant summarizer.',
    task: 'Given a list of transactions that were just created, produce a short, friendly summary in the same language the user wrote in.',
    rules: [
        'Mention the number of transactions created.',
        'List each transaction with its amount (R$), description, and category if available.',
        'If any transactions failed, mention them at the end.',
        'Be concise — 1-3 sentences is ideal.',
    ],
});

export function createGenerateSummaryNode(llmClient: OpenRouterService) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        console.log('💬 Generating summary...');
        try {
            const userPrompt = JSON.stringify({
                createdTransactions: state.createdTransactions,
            });

            const result = await llmClient.generateStructured(
                SYSTEM_PROMPT,
                userPrompt,
                SummarySchema
            );

            if (!result.success) {
                console.warn('⚠️  Summary generation failed:', result.error);
                return { summary: `Created ${state.createdTransactions?.length ?? 0} transaction(s).` };
            }

            console.log('✅ Summary generated');
            return { summary: result.data!.summary };
        } catch (error) {
            console.error('❌ Error generating summary:', error);
            return { summary: `Created ${state.createdTransactions?.length ?? 0} transaction(s).` };
        }
    };
}
