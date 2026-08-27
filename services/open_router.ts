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

// Incremental events emitted by runAgentStream as the agent works, so callers
// can forward a live, ChatGPT-style view of the run: answer text arrives token
// by token, and every tool call is announced when it starts and when it ends.
// The terminal 'result' event carries the same AgentRunResult runAgent returns.
export type AgentStreamEvent =
  | { type: 'token'; value: string }
  | { type: 'tool_start'; name: string; args?: unknown }
  | { type: 'tool_end'; name: string }
  | { type: 'result'; result: AgentRunResult };

// A tool run surfaces its output as a ToolMessage (or, for some providers, the
// raw returned value). Normalize it to the string the tool actually returned so
// callers can parse it (e.g. to pull ids out of a create_transaction result).
function stringifyToolOutput(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  const content = (output as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return extractText(output as BaseMessage);
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

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

// OpenRouter answers 402 when the account is out of credits (or the request's
// max_tokens costs more than the remaining balance). The OpenAI SDK surfaces
// this as an error carrying `status: 402`; we also match the message text since
// LangChain sometimes rethrows a wrapped error where only the message survives.
export function isInsufficientCreditsError(error: unknown): boolean {
  const status = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return status === 402 || /requires more credits|add more credits|can only afford/i.test(message);
}

export class OpenRouterService {
  private llmClient: ChatOpenAI;
  private agentClient: ChatOpenAI;

  constructor() {
    this.llmClient = this.buildClient(config.models);
    this.agentClient = this.buildClient(config.agentModels, {
      temperature: config.agentTemperature,
      maxTokens: config.agentMaxTokens,
    });
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
    // Callers that need a different model/token budget than the shared agent
    // client (e.g. /generate-ui runs on the strong UI model and emits a full
    // HTML document) get a dedicated client; everyone else keeps agentClient.
    model?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<AgentRunResult> {
    const langfuseHandler = new CallbackHandler({
      userId: options.userId,
      sessionId: options.sessionId,
      tags: options.tags ?? ['openrouter', 'agent'],
    });

    const client = options.model
      ? this.buildClient([options.model], {
          temperature: options.temperature ?? config.agentTemperature,
          maxTokens: options.maxTokens,
        })
      : this.agentClient;

    const agent = createAgent({
      model: client,
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
      if (isInsufficientCreditsError(error)) {
        return {
          success: false,
          error: 'insufficient_credits',
          answer: "The AI assistant has reached its usage limit and can't answer right now. Please try again later.",
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

  // Streaming twin of runAgent. Runs the same agentic tool loop but emits the
  // work as it happens via LangGraph's event stream — answer tokens as the
  // model produces them, and each tool call when it starts and finishes — so an
  // endpoint can relay a live view to the client. The generator's final 'result'
  // event carries the exact AgentRunResult runAgent would have returned, so the
  // caller reuses the same persistence/error handling for both paths.
  async *runAgentStream(options: {
    systemPrompt: string;
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
    userId?: string;
    sessionId?: string;
    tags?: string[];
    model?: string;
    maxTokens?: number;
    temperature?: number;
    // Aborts the underlying model calls when the client disconnects, so a
    // browser closing the SSE connection doesn't leave the agent running.
    signal?: AbortSignal;
  }): AsyncGenerator<AgentStreamEvent> {
    const langfuseHandler = new CallbackHandler({
      userId: options.userId,
      sessionId: options.sessionId,
      tags: options.tags ?? ['openrouter', 'agent'],
    });

    const client = options.model
      ? this.buildClient([options.model], {
          temperature: options.temperature ?? config.agentTemperature,
          maxTokens: options.maxTokens,
        })
      : this.agentClient;

    const agent = createAgent({ model: client, tools: options.tools });

    const invokeConfig = {
      callbacks: [langfuseHandler],
      recursionLimit: config.agentRecursionLimit,
      version: 'v2' as const,
      ...(options.signal ? { signal: options.signal } : {}),
    };

    const toolResults: AgentToolResult[] = [];
    const toolsUsed: string[] = [];
    let streamedText = '';
    // The final answer is the text of the last AI turn that made no tool call —
    // intermediate turns stream only tool-call args, so streamedText usually
    // equals it, but we track it explicitly to stay authoritative.
    let finalAnswer = '';

    const initialMessages = [new SystemMessage(options.systemPrompt), ...options.messages];

    try {
      const eventStream = agent.streamEvents({ messages: initialMessages }, invokeConfig);

      // StreamEvent.data fields (chunk/input/output) are typed `any`, so no
      // casts are needed to read them.
      for await (const event of eventStream) {
        switch (event.event) {
          case 'on_chat_model_stream': {
            const text = extractText(event.data.chunk as BaseMessage | undefined);
            if (text) {
              streamedText += text;
              yield { type: 'token', value: text };
            }
            break;
          }
          case 'on_chat_model_end': {
            const message = event.data.output as
              | (BaseMessage & { tool_calls?: unknown[] })
              | undefined;
            const hasToolCalls = (message?.tool_calls?.length ?? 0) > 0;
            const text = extractText(message).trim();
            if (!hasToolCalls && text) finalAnswer = text;
            break;
          }
          case 'on_tool_start': {
            toolsUsed.push(event.name);
            yield { type: 'tool_start', name: event.name, args: event.data.input };
            break;
          }
          case 'on_tool_end': {
            toolResults.push({ name: event.name, content: stringifyToolOutput(event.data.output) });
            yield { type: 'tool_end', name: event.name };
            break;
          }
        }
      }

      let answer = finalAnswer || streamedText.trim();

      // Same empty-final-message guard as runAgent: nudge the model once (the
      // tool results are already in context) and stream the recovered answer so
      // the client still sees text rather than an empty bubble.
      if (!answer) {
        const retry = await agent.invoke(
          {
            messages: [
              ...initialMessages,
              new HumanMessage('Your previous reply was empty. Reply now with the final answer as plain text.'),
            ],
          },
          { callbacks: [langfuseHandler], recursionLimit: config.agentRecursionLimit },
        );
        answer = extractAnswer(retry.messages);
        if (answer) yield { type: 'token', value: answer };
      }

      if (!answer) {
        yield {
          type: 'result',
          result: {
            success: false,
            error: 'empty_agent_response',
            answer: '',
            toolsUsed: [...new Set(toolsUsed)],
            toolResults,
          },
        };
        return;
      }

      yield {
        type: 'result',
        result: { success: true, answer, toolsUsed: [...new Set(toolsUsed)], toolResults },
      };
    } catch (error) {
      if (error instanceof GraphRecursionError) {
        const answer = 'Sorry, that question needed too many steps — try asking something more specific.';
        yield { type: 'token', value: answer };
        yield {
          type: 'result',
          result: { success: false, error: 'agent_recursion_limit', answer, toolsUsed: [], toolResults },
        };
        return;
      }
      if (isInsufficientCreditsError(error)) {
        yield {
          type: 'result',
          result: {
            success: false,
            error: 'insufficient_credits',
            answer: "The AI assistant has reached its usage limit and can't answer right now. Please try again later.",
            toolsUsed: [],
            toolResults,
          },
        };
        return;
      }
      yield {
        type: 'result',
        result: {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          answer: '',
          toolsUsed: [...new Set(toolsUsed)],
          toolResults,
        },
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
