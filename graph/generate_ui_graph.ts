import z from "zod/v3";
import {
  StateGraph,
  START,
  END,
  MessagesZodMeta,
} from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";
import type { BaseMessage } from '@langchain/core/messages';
import { createPlanDataNode, PlannedCallSchema } from "./nodes/plan_data/plan_data.ts";
import { createExecuteToolsNode, type ToolResult } from "./nodes/execute_tools/execute_tools.ts";
import { createGenerateHtmlNode } from "./nodes/generate_html/generate_html.ts";
import { OpenRouterService } from "../services/open_router.ts";
import { McpClientService } from "../services/mcp_client.ts";

const GenerateUiAnnotation = z.object({
  messages: withLangGraph(
    z.custom<BaseMessage[]>(),
    MessagesZodMeta),

  userId: z.string().optional(),
  sessionId: z.string().optional(),

  plannedCalls: z.array(PlannedCallSchema).optional(),
  toolResults: z.custom<ToolResult[]>().optional(),

  html: z.string().optional(),

  error: z.string().optional(),
});

export type GenerateUiState = z.infer<typeof GenerateUiAnnotation>;

export function buildGenerateUiGraph(llmClient: OpenRouterService, mcpClient: McpClientService) {
    const workflow = new StateGraph({
        stateSchema: GenerateUiAnnotation,
    })
        .addNode('planData', createPlanDataNode(llmClient))
        .addNode('executeTools', createExecuteToolsNode(mcpClient))
        .addNode('generateHtml', createGenerateHtmlNode(llmClient))

        .addEdge(START, 'planData')
        .addConditionalEdges('planData', (state: GenerateUiState) =>
            state.error ? END : 'executeTools'
        )
        .addConditionalEdges('executeTools', (state: GenerateUiState) =>
            state.error ? END : 'generateHtml'
        )
        .addEdge('generateHtml', END);

    return workflow.compile();
}
