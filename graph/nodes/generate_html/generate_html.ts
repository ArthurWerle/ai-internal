import type { BaseMessage } from '@langchain/core/messages';
import { OpenRouterService } from "../../../services/open_router.ts";
import { config } from "../../../config/config.ts";
import type { GenerateUiState } from "../../generate_ui_graph.ts";
import { PROMPTS } from './prompts.ts';

function extractTextContent(message: BaseMessage | undefined): string {
    if (!message) return '';
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .filter((part): part is { type: 'text'; text: string } => (part as { type?: string }).type === 'text')
            .map(part => part.text)
            .join('\n');
    }
    return '';
}

function extractHtml(raw: string): string | null {
    let text = raw.trim();
    const fenceMatch = text.match(/^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/);
    if (fenceMatch) text = fenceMatch[1].trim();
    const docStart = text.search(/<!DOCTYPE html|<html/i);
    if (docStart === -1) return null;
    return text.slice(docStart);
}

export function createGenerateHtmlNode(llmClient: OpenRouterService) {
    return async (state: GenerateUiState): Promise<Partial<GenerateUiState>> => {
        console.log('🎨 Generating HTML page...');

        try {
            const userPrompt = JSON.stringify({
                question: extractTextContent(state.messages.at(-1)),
                data: state.toolResults,
                generated_at: new Date().toISOString(),
            });

            const result = await llmClient.generateText(
                PROMPTS.getSystemPrompt(),
                userPrompt,
                {
                    userId: state.userId,
                    sessionId: state.sessionId,
                    tags: ['generate-ui', 'generate-html'],
                    model: config.uiGenerationModel,
                    maxTokens: 32000,
                },
            );

            if (!result.success) {
                console.warn('⚠️  HTML generation failed:', result.error);
                return { error: result.error };
            }

            const html = extractHtml(result.data!);
            if (!html) {
                return { error: 'Model did not return an HTML document.' };
            }

            console.log('✅ HTML page generated');
            return { html };
        } catch (error) {
            console.error('❌ Error in generateHtml node:', error);
            return {
                error: error instanceof Error ? error.message : 'HTML generation failed',
            };
        }
    };
}
