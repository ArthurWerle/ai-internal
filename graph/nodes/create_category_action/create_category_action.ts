import z from "zod/v3";
import { OpenRouterService } from "../../../services/open_router.ts";
import { McpClientService } from "../../../services/mcp_client.ts";
import type { AskGraphState } from "../../ask_graph.ts";
import { PROMPTS } from './prompts.ts';

const ExtractedCategorySchema = z.object({
    name: z.string().describe('Name of the category to create'),
    description: z.string().optional().describe('Short description of the category'),
    color: z.string().optional().describe('Color for the category, if mentioned'),
});

export function createCreateCategoryActionNode(llmClient: OpenRouterService, mcpClient: McpClientService) {
    return async (state: AskGraphState): Promise<Partial<AskGraphState>> => {
        console.log('🏷️  Running create-category action...');

        const lastMessage = state.messages.at(-1);
        if (!lastMessage) {
            return { error: 'No messages in state.' };
        }

        try {
            const result = await llmClient.generateStructured(
                PROMPTS.getSystemPrompt(),
                lastMessage,
                ExtractedCategorySchema,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['ask-endpoint', 'create-category'],
                    history: state.messages.slice(0, -1),
                },
            );

            if (!result.success) {
                console.warn('⚠️  Category extraction failed:', result.error);
                return { error: result.error };
            }

            if (!result.data!.name) {
                return { error: 'Could not determine a category name from the message.' };
            }

            const created = await mcpClient.createCategory(result.data!);

            console.log(`✅ Created category: ${result.data!.name}`);
            return { createdCategory: created };
        } catch (error) {
            console.error('❌ Error in createCategoryAction node:', error);
            return {
                error: error instanceof Error ? error.message : 'Category creation failed',
            };
        }
    };
}
