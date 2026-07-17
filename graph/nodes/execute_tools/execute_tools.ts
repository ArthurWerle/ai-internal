import { McpClientService } from "../../../services/mcp_client.ts";
import type { GenerateUiState } from "../../generate_ui_graph.ts";
import type { PlannedCall } from "../plan_data/plan_data.ts";

export type ToolResult = {
    tool: string;
    params: Record<string, unknown>;
    result?: unknown;
    error?: string;
};

function pickParams(call: PlannedCall): Record<string, unknown> {
    const { tool: _tool, ...params } = call;
    return Object.fromEntries(
        Object.entries(params).filter(([, value]) => value !== undefined),
    );
}

async function dispatch(mcpClient: McpClientService, call: PlannedCall): Promise<unknown> {
    switch (call.tool) {
        case 'list_categories':
            return mcpClient.listCategories();
        case 'list_subcategories':
            return mcpClient.listSubcategories();
        case 'list_locations':
            return mcpClient.listLocations();
        case 'list_transactions':
            return mcpClient.listTransactions({
                category: call.category,
                query: call.query,
                type: call.type,
                start_date: call.start_date,
                end_date: call.end_date,
                limit: call.limit,
                offset: call.offset,
            });
        case 'get_transaction':
            if (call.id === undefined) {
                throw new Error('No transaction id provided.');
            }
            return mcpClient.getTransaction(call.id);
        case 'get_latest_transactions':
            return mcpClient.getLatestTransactions(call.limit);
        case 'get_biggest_transactions':
            return mcpClient.getBiggestTransactions({ month: call.month, year: call.year });
        case 'get_average_by_type':
            return mcpClient.getAverageByType();
        case 'get_average_by_category':
            return mcpClient.getAverageByCategory({
                category_id: call.category_id,
                start_date: call.start_date,
                end_date: call.end_date,
            });
    }
}

export function createExecuteToolsNode(mcpClient: McpClientService) {
    return async (state: GenerateUiState): Promise<Partial<GenerateUiState>> => {
        console.log('🛠️  Executing planned tool calls...');

        const results: ToolResult[] = [];
        for (const call of state.plannedCalls ?? []) {
            const params = pickParams(call);
            try {
                const result = await dispatch(mcpClient, call);
                results.push({ tool: call.tool, params, result });
                console.log(`✅ ${call.tool} done`);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Tool call failed';
                results.push({ tool: call.tool, params, error: message });
                console.warn(`⚠️  ${call.tool} failed:`, message);
            }
        }

        if (results.length === 0) {
            return { error: 'No data queries were planned.' };
        }
        if (results.every((result) => result.error)) {
            return { toolResults: results, error: 'All data queries failed.' };
        }
        return { toolResults: results };
    };
}
