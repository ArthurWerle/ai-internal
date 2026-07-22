import { ChatOpenAI } from '@langchain/openai';
import { config } from '../config/config.ts';
import { AIMessage, SystemMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { z } from 'zod/v3';
import { createAgent, providerStrategy } from 'langchain';
import { GraphRecursionError } from '@langchain/langgraph';
import { CallbackHandler } from '@langfuse/langchain';

export type LLMResponse = {
  model: string;
  content: string;
};

export type AgentToolResult = {
  name: string;
  content: string;
};

export type AgentRunResult = {
  success: boolean;
  answer: string;
  toolsUsed: string[];
  // Raw result of every tool call the agent made, in order, so callers can
  // inspect what the tools actually returned (e.g. ids of created records).
  toolResults: AgentToolResult[];
  error?: string;
};

// The last AI message should carry the answer, but flaky providers sometimes
// append an empty final message after the real one — scan backwards for the
// last AI message with actual text and no pending tool calls.
function extractAnswer(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!(message instanceof AIMessage)) continue;
    if ((message.tool_calls?.length ?? 0) > 0) continue;
    const text = extractText(message).trim();
    if (text) return text;
  }
  return '';
}

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
      model?: string;
      temperature?: number;
    }
  ) {
    try {
      const langfuseHandler = new CallbackHandler({
        userId: options?.userId,
        sessionId: options?.sessionId,
        tags: options?.tags ?? ['openrouter', 'structured-output'],
      });

      // Callers that need a different model/temperature than the shared cheap
      // client (e.g. receipt classification) get a dedicated client; everyone
      // else keeps the default llmClient untouched.
      const client = options?.model
        ? this.buildClient([options.model], { temperature: options?.temperature })
        : this.llmClient;

      const agent = createAgent({
        model: client,
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

    const invokeConfig = { callbacks: [langfuseHandler], recursionLimit: config.agentRecursionLimit };

    try {
      const result = await agent.invoke(
        { messages: [new SystemMessage(options.systemPrompt), ...options.messages] },
        invokeConfig,
      );

      let messages = result.messages;
      let answer = extractAnswer(messages);

      // Some providers (Gemini via OpenRouter in particular) intermittently
      // end the tool loop with an empty message; nudge the model once to
      // restate the answer — the tool results are already in its context.
      if (!answer) {
        const retry = await agent.invoke(
          {
            messages: [
              ...messages,
              new HumanMessage('Your previous reply was empty. Reply now with the final answer as plain text.'),
            ],
          },
          invokeConfig,
        );
        messages = retry.messages;
        answer = extractAnswer(messages);
      }

      const toolsUsed = messages
        .filter((m): m is AIMessage => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0)
        .flatMap((m) => m.tool_calls!.map((c) => c.name));

      const toolResults = messages
        .filter((m): m is ToolMessage => m instanceof ToolMessage)
        .map((m) => ({ name: m.name ?? '', content: extractText(m) }));

      if (!answer) {
        const finalAiMessage = [...messages].reverse().find((m) => m instanceof AIMessage);
        console.warn(
          '⚠️  Agent finished without any text output. Final AI message:',
          JSON.stringify({
            content: finalAiMessage?.content,
            response_metadata: finalAiMessage?.response_metadata,
          }).substring(0, 1000),
        );
        return {
          success: false,
          error: 'empty_agent_response',
          answer: '',
          toolsUsed: [...new Set(toolsUsed)],
          toolResults,
        };
      }

      return { success: true, answer, toolsUsed: [...new Set(toolsUsed)], toolResults };
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        return {
          success: false,
          error: 'agent_recursion_limit',
          answer: 'Sorry, that question needed too many steps — try asking something more specific.',
          toolsUsed: [],
          toolResults: [],
        };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        answer: '',
        toolsUsed: [],
        toolResults: [],
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
