import z from "zod/v3";
import {
  StateGraph,
  START,
  END,
  MessagesZodMeta,
} from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { BaseMessage } from '@langchain/core/messages';
import { createIdentifyIntentNode, IntentSchema } from "./nodes/identify_intent/identify_intent.ts";
import { createCreateTransactionActionNode } from "./nodes/create_transaction_action/create_transaction_action.ts";
import { createCreateCategoryActionNode } from "./nodes/create_category_action/create_category_action.ts";
import { createQueryDataActionNode } from "./nodes/query_data_action/query_data_action.ts";
import { createGenerateAnswerNode } from "./nodes/generate_answer/generate_answer.ts";
import { OpenRouterService } from "../services/open_router.ts";
import { McpClientService } from "../services/mcp_client.ts";

const AskGraphAnnotation = z.object({
  messages: withLangGraph(
    z.custom<BaseMessage[]>(),
    MessagesZodMeta),

  userId: z.string().optional(),
  sessionId: z.string().optional(),

  intent: IntentSchema.optional(),

  createdTransactions: z.array(z.record(z.unknown())).optional(),
  createdCategory: z.record(z.unknown()).optional(),
  queryResult: z.unknown().optional(),
  queryTool: z.string().optional(),

  answer: z.string().optional(),
  error: z.string().optional(),
});

export type AskGraphState = z.infer<typeof AskGraphAnnotation>;

export function buildAskGraph(llmClient: OpenRouterService, mcpClient: McpClientService) {
    const workflow = new StateGraph({
        stateSchema: AskGraphAnnotation,
    })
        .addNode('identifyIntent', createIdentifyIntentNode(llmClient))
        .addNode('createTransactionAction', createCreateTransactionActionNode(llmClient, mcpClient))
        .addNode('createCategoryAction', createCreateCategoryActionNode(llmClient, mcpClient))
        .addNode('queryDataAction', createQueryDataActionNode(llmClient, mcpClient))
        .addNode('generateAnswer', createGenerateAnswerNode(llmClient))

        .addEdge(START, 'identifyIntent')
        .addConditionalEdges('identifyIntent', (state: AskGraphState) => {
            switch (state.intent) {
                case 'create_transaction': return 'createTransactionAction';
                case 'create_category': return 'createCategoryAction';
                case 'query_data': return 'queryDataAction';
                default: return 'generateAnswer';
            }
        })
        .addEdge('createTransactionAction', 'generateAnswer')
        .addEdge('createCategoryAction', 'generateAnswer')
        .addEdge('queryDataAction', 'generateAnswer')
        .addEdge('generateAnswer', END);

    return workflow.compile();
}
