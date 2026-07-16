import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { GraphState } from "../../receipt_scanner.ts";

const SummarySchema = z.object({
    summary: z.string().describe('Human-friendly summary of what was created'),
});

const SYSTEM_PROMPT = JSON.stringify({
    role: 'Financial assistant summarizer.',
    task: 'Given the transactions that were just created (and any that failed), produce a short, friendly summary in the same language the user wrote in.',
    rules: [
        'Report EXACTLY createdCount as the number of transactions created. Never report a different number.',
        'List each created transaction with its description and amount formatted as Brazilian Reais (R$, pt-BR — e.g. R$ 906,47), plus category if available.',
        'If failedCount > 0, you MUST clearly state that those items were NOT created and list each failed item with its description, its amount formatted as Brazilian Reais (R$, pt-BR — e.g. R$ 906,47) and error reason. Never present a failed item as created.',
        'Mention the transaction date. If any created transaction has a date that is not today (see today in the input), call that out explicitly with the item and its date, so the user knows where to find it.',
        'Be concise, but never omit failures.',
    ],
});

export function createGenerateSummaryNode(llmClient: OpenRouterService) {
    return async (state: GraphState): Promise<Partial<GraphState>> => {
        console.log('💬 Generating summary...');
        const all = state.createdTransactions ?? [];
        const created = all.filter(t => !t.error);
        const failed = all.filter(t => t.error);

        // Deterministic fallback so the user still gets an accurate count if
        // the LLM call fails — never claim failed items were created.
        const fallbackSummary = failed.length > 0
            ? `Created ${created.length} transaction(s). ${failed.length} failed: ${failed.map(f => `"${f.description}"`).join(', ')}.`
            : `Created ${created.length} transaction(s).`;

        try {
            const userPrompt = JSON.stringify({
                today: new Date().toISOString(),
                createdCount: created.length,
                failedCount: failed.length,
                createdTransactions: created,
                failedTransactions: failed,
            });

            const result = await llmClient.generateStructured(
                SYSTEM_PROMPT,
                userPrompt,
                SummarySchema
            );

            if (!result.success) {
                console.warn('⚠️  Summary generation failed:', result.error);
                return { summary: fallbackSummary };
            }

            console.log('✅ Summary generated');
            return { summary: result.data!.summary };
        } catch (error) {
            console.error('❌ Error generating summary:', error);
            return { summary: fallbackSummary };
        }
    };
}
