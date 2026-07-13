import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import type { AskGraphState } from "../../ask_graph.ts";
import { PROMPTS } from './prompts.ts';

export const IntentSchema = z.enum([
    'create_transaction',
    'create_category',
    'query_data',
    'general_chat',
]);

const ResponseSchema = z.object({
    intent: IntentSchema,
    reasoning: z.string().optional(),
});

export function createIdentifyIntentNode(llmClient: OpenRouterService) {
    return async (state: AskGraphState): Promise<Partial<AskGraphState>> => {
        console.log('🧭 Identifying intent...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { intent: 'general_chat', error: 'No messages in state.' };
        }

        try {
            const result = await llmClient.generateStructured(
                PROMPTS.getSystemPrompt(),
                lastMessage,
                ResponseSchema,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['ask-endpoint', 'identify-intent'],
                    history: state.messages.slice(0, -1),
                },
            );

            if (!result.success) {
                console.warn('⚠️  Identify intent failed:', result.error);
                return { intent: 'general_chat', error: result.error };
            }

            console.log(`✅ Identified intent: ${result.data!.intent}`);
            return { intent: result.data!.intent };

        } catch (error) {
            console.error('❌ Error in identifyIntent node:', error);
            return {
                intent: 'general_chat',
                error: error instanceof Error ? error.message : 'Intent identification failed',
            };
        }
    };
}
