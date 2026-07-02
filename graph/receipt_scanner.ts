import z from "zod/v3";
import {
  StateGraph,
  START,
  END,
  MessagesZodMeta,
} from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { BaseMessage } from '@langchain/core/messages';
import { createFetchContextNode } from "./nodes/fetch_context/fetch_context.ts";
import { createIdentifyMessageNode } from "./nodes/identify_message/identify_message.ts";
import { createValidateInputNode } from "./nodes/validate_input/validate_input.ts";
import { createCreateTransactionsNode } from "./nodes/create_transactions/create_transactions.ts";
import { createGenerateSummaryNode } from "./nodes/generate_summary/generate_summary.ts";
import { OpenRouterService } from "../services/open_router.ts";
import { McpClientService } from "../services/mcp_client.ts";

export const CategorySchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const SubcategorySchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const LocationSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const ExtractedItemSchema = z.object({
  categoryId: z.number().optional(),
  subcategoryId: z.number().optional(),
  datetime: z.string(),
  value: z.number(),
  type: z.enum(['income', 'expense']).optional(),
  description: z.string(),
  location: z.string().optional(),
});

export const CreatedTransactionSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  amount: z.number().optional(),
  type: z.string().optional(),
  description: z.string().optional(),
  date: z.string().optional(),
  location: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

const ReceiptScannerAnnotation = z.object({
  messages: withLangGraph(
    z.custom<BaseMessage[]>(),
    MessagesZodMeta),

  categories: z.array(CategorySchema).optional(),
  subcategories: z.array(SubcategorySchema).optional(),
  locations: z.array(LocationSchema).optional(),

  items: z.array(ExtractedItemSchema).optional(),

  createdTransactions: z.array(CreatedTransactionSchema).optional(),

  summary: z.string().optional(),

  error: z.string().optional(),
});

export type GraphState = z.infer<typeof ReceiptScannerAnnotation>;

export function buildReceiptScannerGraph(llmClient: OpenRouterService, mcpClient: McpClientService) {
    const workflow = new StateGraph({
        stateSchema: ReceiptScannerAnnotation,
    })
        .addNode('fetchContext', createFetchContextNode(mcpClient))
        .addNode('identifyMessage', createIdentifyMessageNode(llmClient))
        .addNode('validateInput', createValidateInputNode())
        .addNode('createTransactions', createCreateTransactionsNode(mcpClient))
        .addNode('generateSummary', createGenerateSummaryNode(llmClient))

        .addEdge(START, 'fetchContext')
        .addEdge('fetchContext', 'identifyMessage')
        .addEdge('identifyMessage', 'validateInput')
        .addConditionalEdges('validateInput', (state: GraphState) =>
            state.error ? END : 'createTransactions'
        )
        .addEdge('createTransactions', 'generateSummary')
        .addEdge('generateSummary', END);

    return workflow.compile();
}
