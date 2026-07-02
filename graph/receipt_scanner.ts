import z from "zod/v3";
import {
  StateGraph,
  START,
  END,
  MessagesZodMeta,
} from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { BaseMessage } from '@langchain/core/messages';
import { createIdentifyMessageNode } from "./nodes/identify_message/identify_message.ts";
import { OpenRouterService } from "../services/open_router.ts";

const TransactionAnnotation = z.object({
    value: z.number(),
    description: z.string(),
    category: z.number(),
    subcategory: z.number().optional(),
    date: z.date(),
    location: z.string().optional(),

})

const ReceiptScannerAnnotation = z.object({
  messages: withLangGraph(
    z.custom<BaseMessage[]>(),
    MessagesZodMeta),

  totalValue: z.number(),
  items: z.array(TransactionAnnotation),

  error: z.string().optional(),
});

export type GraphState = z.infer<typeof ReceiptScannerAnnotation>;

export function buildReceiptScannerGraph(llmClient: OpenRouterService) {
    const workflow = new StateGraph({
        stateSchema: ReceiptScannerAnnotation,
    })
        // nodes
        .addNode('identifyMessage', createIdentifyMessageNode(llmClient))

        // flow
        .addEdge(START, 'identifyMessage')
        .addEdge('message', END);

    return workflow.compile();
}