import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSystemPrompt } from '../graph/nodes/identify_message/prompts.ts';
import { buildSystemPrompt } from '../graph/ask_agent.ts';
import { CATEGORY_RULE, SUBCATEGORY_RULE, LOCATION_RULE } from '../graph/shared/classification_rules.ts';

// Both the /scan extraction prompt and the /ask agent prompt must embed the
// SAME shared classification rules — that is the whole point of the shared
// module. These tests fail if either prompt drifts back to its own copy.

test('/scan prompt embeds the shared classification rules', () => {
    const parsed = JSON.parse(getSystemPrompt([], [], []));
    const instructions = parsed.extraction_instructions;

    assert.ok(instructions.category.includes(CATEGORY_RULE));
    assert.ok(instructions.subcategory.includes(SUBCATEGORY_RULE));
    assert.ok(instructions.location.includes(LOCATION_RULE));
});

test('/ask prompt embeds the same shared classification rules', () => {
    const parsed = JSON.parse(buildSystemPrompt('2026-07-22', [], [], []));
    const rules: string[] = parsed.rules;

    assert.ok(rules.some((rule) => rule.includes(CATEGORY_RULE)));
    assert.ok(rules.some((rule) => rule.includes(SUBCATEGORY_RULE)));
    assert.ok(rules.some((rule) => rule.includes(LOCATION_RULE)));
});
