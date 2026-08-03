import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInsufficientCreditsError } from '../services/open_router.ts';

test('isInsufficientCreditsError: true when the error carries a 402 status', () => {
    assert.equal(isInsufficientCreditsError({ status: 402, message: 'Payment Required' }), true);
});

test('isInsufficientCreditsError: true for OpenRouter credit-limit message text', () => {
    const message =
        'This request requires more credits, or fewer max_tokens. You requested up to 64000 tokens, but can only afford 31718.';
    assert.equal(isInsufficientCreditsError(new Error(message)), true);
});

test('isInsufficientCreditsError: matches even when only the message string survives', () => {
    // LangChain sometimes rethrows a wrapped error where the status is lost but
    // the original message is preserved.
    assert.equal(isInsufficientCreditsError('402 add more credits at openrouter.ai'), true);
});

test('isInsufficientCreditsError: false for unrelated errors', () => {
    assert.equal(isInsufficientCreditsError(new Error('network timeout')), false);
    assert.equal(isInsufficientCreditsError({ status: 500, message: 'Internal Server Error' }), false);
    assert.equal(isInsufficientCreditsError(undefined), false);
});
