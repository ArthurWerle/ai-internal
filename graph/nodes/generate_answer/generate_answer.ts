import z from "zod/v3";
import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from "../../../services/open_router.ts";
import type { AskGraphState } from "../../ask_graph.ts";

const AnswerSchema = z.object({
    answer: z.string().describe('The final, user-facing reply'),
});

const SYSTEM_PROMPT = JSON.stringify({
    role: 'Personal finance chat assistant.',
    task: 'Given the classified intent and the result of any action that was taken, write a short, friendly, user-facing reply in the same language the user wrote in.',
    rules: [
        'If a category was created, confirm its name.',
        'If query data is present, summarize it using only the actual numbers/values provided — never invent data.',
        'If an error is present, apologize briefly and plainly, without leaking internal error details.',
        'For general_chat, just answer conversationally based on the last user message.',
        'Be concise — 1-3 sentences is ideal.',
    ],
});

function extractTextContent(message: BaseMessage | undefined): string {
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((part): part is { type: 'text'; text: string } => (part as any).type === 'text')
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

export function createGenerateAnswerNode(llmClient: OpenRouterService) {
    return async (state: AskGraphState): Promise<Partial<AskGraphState>> => {
        if (state.answer) {
            return {};
        }

        console.log('💬 Generating answer...');
        try {
            const userPrompt = JSON.stringify({
                intent: state.intent,
                lastUserMessage: extractTextContent(state.messages.at(-1)),
                createdCategory: state.createdCategory,
                queryResult: state.queryResult,
                queryTool: state.queryTool,
                error: state.error,
            });

            const result = await llmClient.generateStructured(
                SYSTEM_PROMPT,
                userPrompt,
                AnswerSchema,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['ask-endpoint', 'generate-answer'],
                    history: state.messages.slice(0, -1),
                },
            );

            if (!result.success) {
                console.warn('⚠️  Answer generation failed:', result.error);
                return {
                    answer: state.error
                        ? `Sorry, something went wrong: ${state.error}`
                        : "Sorry, I couldn't process that request.",
                };
            }

            console.log('✅ Answer generated');
            return { answer: result.data!.answer };
        } catch (error) {
            console.error('❌ Error generating answer:', error);
            return { answer: 'Sorry, something went wrong while answering.' };
        }
    };
}
