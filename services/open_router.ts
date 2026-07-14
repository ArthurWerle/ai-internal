import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config/config.ts';
import { AIMessage, SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod/v3';
import { createAgent, providerStrategy } from 'langchain';
import { GraphRecursionError } from '@langchain/langgraph';
import { CallbackHandler } from '@langfuse/langchain';
import { startActiveObservation, propagateAttributes } from '@langfuse/tracing';

export type LLMResponse = {
  model: string;
  content: string;
};

export type AgentRunResult = {
  success: boolean;
  answer: string;
  toolsUsed: string[];
  error?: string;
};

function extractText(message: BaseMessage | undefined): string {
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

export class OpenRouterService {
  private llmClient: ChatOpenAI;
  private agentClient: ChatOpenAI;

  constructor() {
    this.llmClient = this.buildClient(config.models);
    this.agentClient = this.buildClient(config.agentModels, { temperature: config.agentTemperature });
  }

  private buildClient(models: string[], options?: { temperature?: number; maxTokens?: number }): ChatOpenAI {
    return new ChatOpenAI({
      apiKey: config.apiKey,
      modelName: models[0],
      temperature: options?.temperature ?? config.temperature,
      ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
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
        data: (data as { structuredResponse: unknown }).structuredResponse as T,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // Runs a full agentic tool loop: the model calls tools, observes each
  // result, and decides the next call until it can produce a final answer.
  async runAgent(options: {
    systemPrompt: string;
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
    name?: string;
    userId?: string;
    sessionId?: string;
    tags?: string[];
  }): Promise<AgentRunResult> {
    const langfuseHandler = new CallbackHandler({
      userId: options.userId,
      sessionId: options.sessionId,
      tags: options.tags ?? ['openrouter', 'agent'],
    });

    const agent = createAgent({
      model: this.agentClient,
      tools: options.tools,
    });

    // Named root observation so the LangChain spans nest under one trace and
    // post-run attributes (tools used) can be attached at the trace level.
    return startActiveObservation(options.name ?? 'agent', async (span) => {
      span.update({ input: extractText(options.messages[options.messages.length - 1]) });

      try {
        const result = await agent.invoke(
          { messages: [new SystemMessage(options.systemPrompt), ...options.messages] },
          { callbacks: [langfuseHandler], recursionLimit: config.agentRecursionLimit },
        );

        const finalAiMessage = [...result.messages].reverse().find((m) => m instanceof AIMessage);
        const answer = extractText(finalAiMessage);
        const toolCalls = result.messages
          .filter((m): m is AIMessage => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0)
          .flatMap((m) => m.tool_calls!.map((c) => c.name));
        const toolsUsed = [...new Set(toolCalls)];

        // Surfaces tool usage in the Langfuse traces list, so it's filterable
        // without opening each trace tree. Metadata values must be strings of
        // at most 200 characters.
        propagateAttributes(
          {
            metadata: {
              toolsUsed: (toolsUsed.join(', ') || 'none').slice(0, 200),
              toolCallCount: String(toolCalls.length),
            },
          },
          () => {},
        );

        span.update({ output: answer });
        return { success: true, answer, toolsUsed };
      } catch (error) {
        if (error instanceof GraphRecursionError) {
          return {
            success: false,
            error: 'agent_recursion_limit',
            answer: 'Sorry, that question needed too many steps — try asking something more specific.',
            toolsUsed: [],
          };
        }
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          answer: '',
          toolsUsed: [],
        };
      }
    }, { asType: 'agent' });
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
        ? this.buildClient([options.model], { maxTokens: options?.maxTokens })
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
