import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config/config.ts';
import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { z } from 'zod/v3';
import { createAgent, providerStrategy } from 'langchain';
import { CallbackHandler } from '@langfuse/langchain';

export type LLMResponse = {
  model: string;
  content: string;
};

export class OpenRouterService {
  private llmClient: ChatOpenAI;

  constructor() {
    this.llmClient = this.buildClient(config.models);
  }

  private buildClient(models: string[], maxTokens?: number): ChatOpenAI {
    return new ChatOpenAI({
      apiKey: config.apiKey,
      modelName: models[0],
      temperature: config.temperature,
      ...(maxTokens ? { maxTokens } : {}),
      configuration: {
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': config.httpReferer,
          'X-Title': config.xTitle,
        },
      },

      // Pass provider routing and models array to OpenRouter
      modelKwargs: {
        models,
        provider: config.provider,
      },
    });
  }

  async generateStructured<T>(
    systemPrompt: string,
    userInput: string | BaseMessage,
    schema: z.ZodSchema<T>,
    options?: {
      userId?: string;
      sessionId?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
      history?: BaseMessage[];
    }
  ) {
    try {
      const langfuseHandler = new CallbackHandler({
        userId: options?.userId,
        sessionId: options?.sessionId,
        tags: options?.tags ?? ['openrouter', 'structured-output'],
      });

      const agent = createAgent({
        model: this.llmClient,
        tools: [],
        responseFormat: providerStrategy(schema),
      })

      const userMessage = typeof userInput === 'string' ? new HumanMessage(userInput) : userInput;
      const messages = [
        new SystemMessage(systemPrompt),
        ...(options?.history ?? []),
        userMessage,
      ];

      const data = await agent.invoke(
        { messages },
        { callbacks: [langfuseHandler] }
      );

      return {
        success: true,
        data: data.structuredResponse as T,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async generateText(
    systemPrompt: string,
    userInput: string,
    options?: {
      userId?: string;
      sessionId?: string;
      tags?: string[];
      model?: string;
      maxTokens?: number;
    }
  ) {
    try {
      const langfuseHandler = new CallbackHandler({
        userId: options?.userId,
        sessionId: options?.sessionId,
        tags: options?.tags ?? ['openrouter', 'text-output'],
      });

      const client = options?.model
        ? this.buildClient([options.model], options?.maxTokens)
        : this.llmClient;

      const response = await client.invoke(
        [new SystemMessage(systemPrompt), new HumanMessage(userInput)],
        { callbacks: [langfuseHandler] },
      );

      const content = typeof response.content === 'string'
        ? response.content
        : response.content
            .filter((part): part is { type: 'text'; text: string } => (part as { type?: string }).type === 'text')
            .map((part) => part.text)
            .join('\n');

      return {
        success: true,
        data: content,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}