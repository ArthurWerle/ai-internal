import { GraphState } from "../../receipt_scanner.ts";

export function createValidateInputNode() {
    return (state: GraphState): Partial<GraphState> => {
        console.log('🔎 Validating extracted items...');

        if (!state.items || state.items.length === 0) {
            return { error: 'No transaction items could be extracted from the input.' };
        }

        for (const item of state.items) {
            if (!item.value || item.value <= 0) {
                return { error: `Item "${item.description}" has an invalid amount: ${item.value}` };
            }
        }

        console.log(`✅ Validation passed for ${state.items.length} item(s)`);
        return {};
    };
}
