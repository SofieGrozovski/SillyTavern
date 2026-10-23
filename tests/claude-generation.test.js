import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as actualUtil from '../src/util.js';

// Capture the actual serialized provider request through the real route and
// prompt converter, without credentials, network access, or user chat history.
const fetchMock = jest.fn();
const forwardMock = jest.fn();
jest.unstable_mockModule('node-fetch', () => ({ default: fetchMock }));
jest.unstable_mockModule('../src/util.js', () => ({
    ...actualUtil,
    getConfigValue: (_key, fallback) => fallback,
    forwardFetchResponse: forwardMock,
}));
jest.unstable_mockModule('../src/users.js', () => ({ getCookieSecret: jest.fn() }));
jest.unstable_mockModule('../src/endpoints/tokenizers.js', () => ({
    getTokenizerModel: jest.fn(),
    getSentencepiceTokenizer: jest.fn(),
    getTiktokenTokenizer: jest.fn(),
    sentencepieceTokenizers: {},
    TEXT_COMPLETION_MODELS: [],
    webTokenizers: {},
    getWebTokenizer: jest.fn(),
}));

let generate;
beforeAll(async () => {
    const backend = await import('../src/endpoints/backends/chat-completions.js');
    generate = backend.router.stack.find(layer => layer.route?.path === '/generate').route.stack[0].handle;
});

beforeEach(() => {
    fetchMock.mockReset();
    forwardMock.mockClear();
    fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ content: [{ type: 'tool_use', id: 'synthetic-call', name: 'SillyDice', input: { formula: '2d6' } }] }),
    });
});

const diceTool = {
    type: 'function',
    function: {
        name: 'SillyDice',
        description: 'Roll dice',
        parameters: { type: 'object', properties: { formula: { type: 'string' } }, required: ['formula'] },
    },
};
const namedChoice = { type: 'function', function: { name: 'SillyDice' } };
const jsonSchema = { name: 'result', value: { type: 'object', properties: { total: { type: 'integer' } }, required: ['total'] } };

async function invoke(overrides = {}) {
    const response = { statusCode: 200 };
    response.status = jest.fn(code => { response.statusCode = code; return response; });
    response.send = jest.fn(() => response);
    const request = {
        body: {
            chat_completion_source: 'claude',
            model: 'claude-haiku-5-5',
            messages: [{ role: 'user', content: 'Call SillyDice to roll 2d6.' }],
            reverse_proxy: 'https://claude-proxy.example/v1',
            proxy_password: 'test-key',
            max_tokens: 8192,
            reasoning_effort: 'high',
            tools: [structuredClone(diceTool)],
            ...structuredClone(overrides),
        },
        socket: new EventEmitter(),
    };
    const originalChoice = structuredClone(request.body.tool_choice);
    await generate(request, response);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request.body.tool_choice).toEqual(originalChoice);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://claude-proxy.example/v1/messages');
    return { body: JSON.parse(options.body), response };
}

describe('Claude tool choice conversion', () => {
    test.each([false, true])('converts Agent Runtime named choices with stream=%s', async stream => {
        const { body, response } = await invoke({ tool_choice: namedChoice, stream });
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'SillyDice' });
        expect(body.tools).toEqual([{
            name: 'SillyDice', description: 'Roll dice', input_schema: diceTool.function.parameters,
        }]);
        expect(body.thinking).toEqual({ type: 'adaptive' });
        if (stream) {
            expect(forwardMock).toHaveBeenCalledWith(expect.anything(), response);
        } else {
            expect(response.send).toHaveBeenCalledWith(expect.objectContaining({
                content: [{ type: 'tool_use', id: 'synthetic-call', name: 'SillyDice', input: { formula: '2d6' } }],
            }));
        }
    });

    test.each([
        [undefined, { type: 'auto' }],
        [null, { type: 'auto' }],
        ['auto', { type: 'auto' }],
        ['none', { type: 'none' }],
        ['required', { type: 'any' }],
        ['any', { type: 'any' }],
        [{ type: 'auto', disable_parallel_tool_use: true }, { type: 'auto', disable_parallel_tool_use: true }],
        [{ type: 'none' }, { type: 'none' }],
        [{ type: 'any', disable_parallel_tool_use: true }, { type: 'any', disable_parallel_tool_use: true }],
        [{ type: 'tool', name: 'SillyDice', disable_parallel_tool_use: true }, { type: 'tool', name: 'SillyDice', disable_parallel_tool_use: true }],
    ])('converts or preserves %j', async (choice, expected) => {
        const { body } = await invoke({ tool_choice: choice });
        expect(body.tool_choice).toEqual(expected);
    });

    test.each(['claude-opus-5', 'anthropic/claude-haiku-5-5'])('retains forced calls on supported model %s', async model => {
        const { body } = await invoke({ model, tool_choice: namedChoice });
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'SillyDice' });
    });

    test('does not send tool choice without client tools', async () => {
        const { body } = await invoke({ tools: [], tool_choice: namedChoice });
        expect(body).not.toHaveProperty('tool_choice');
        expect(body).not.toHaveProperty('tools');
    });

    test('keeps the Haiku JSON tool override after normalizing client tool choice', async () => {
        const { body } = await invoke({ tool_choice: namedChoice, json_schema: jsonSchema });
        expect(body.tool_choice).toEqual({ type: 'tool', name: 'result' });
        expect(body.tools.map(tool => tool.name)).toEqual(['SillyDice', 'result']);
        expect(body).not.toHaveProperty('output_config.format');
    });
});

describe.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'anthropic/claude-fable-5-1', 'anthropic/claude-opus-5-5'])('%s forced tool restrictions', model => {
    test.each([namedChoice, 'required', 'any', { type: 'tool', name: 'SillyDice' }, { type: 'any' }])('uses auto for %j', async choice => {
        const { body } = await invoke({ model, tool_choice: choice });
        expect(body.tool_choice).toEqual({ type: 'auto' });
        expect(body.tools.map(tool => tool.name)).toEqual(['SillyDice']);
    });

    test.each(['auto', 'none'])('preserves explicit %s', async choice => {
        const { body } = await invoke({ model, tool_choice: choice });
        expect(body.tool_choice).toEqual({ type: choice });
    });

    test('preserves parallel tool control when falling back to auto', async () => {
        const { body } = await invoke({ model, tool_choice: { type: 'tool', name: 'SillyDice', disable_parallel_tool_use: true } });
        expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    });

    test('keeps native JSON output and effort alongside the auto fallback', async () => {
        const { body } = await invoke({ model, tool_choice: namedChoice, json_schema: jsonSchema });
        expect(body.tool_choice).toEqual({ type: 'auto' });
        expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: jsonSchema.value }, effort: 'high' });
        expect(body.tools.map(tool => tool.name)).toEqual(['SillyDice']);
    });
});


describe('Claude refusal diagnostics', () => {
    test.each([[], [{ type: 'text', text: 'Partial response' }], [{ type: 'tool_use', id: 'partial', name: 'SillyDice', input: {} }]].map(content => [content]))(
        'rejects refused output before any tool can execute: %j', async content => {
            const details = { type: 'refusal', category: 'reasoning_extraction', explanation: 'Synthetic policy explanation.' };
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({
                content, stop_reason: 'refusal', stop_details: details, id: 'synthetic-refusal', model: 'claude-sonnet-5-5',
            }) });
            const { response } = await invoke();
            const reply = response.send.mock.calls[0][0];
            expect(reply.error).toMatchObject({ type: 'provider_refusal', provider: 'claude', reason: 'reasoning_extraction',
                details: { stop_reason: 'refusal', stop_details: details, id: 'synthetic-refusal' } });
            expect(reply).not.toHaveProperty('content');
            expect(reply).not.toHaveProperty('choices');
            const { sendThroughConnectionManager } = await import('./provider-refusal-transport.js');
            await expect(sendThroughConnectionManager(reply)).rejects.toMatchObject({
                code: 'provider_refusal', message: 'Claude refused the request (reasoning_extraction): Synthetic policy explanation.',
                details: reply.error,
            });
        });

    test('reports refusals with no named category or explanation', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) });
        const { response } = await invoke();
        expect(response.send.mock.calls[0][0].error).toMatchObject({ type: 'provider_refusal', reason: 'refusal', message: 'Claude refused the request.' });
    });

    test('preserves normal tool calls and stop metadata through Connection Manager', async () => {
        const content = [{ type: 'tool_use', id: 'allowed', name: 'SillyDice', input: { formula: '1d6' } }];
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content, stop_reason: 'tool_use', stop_details: null }) });
        const { response } = await invoke();
        const reply = response.send.mock.calls[0][0];
        expect(reply).toMatchObject({ content, stop_reason: 'tool_use', stop_details: null });
        expect(reply).not.toHaveProperty('error');
        const { sendThroughConnectionManager } = await import('./provider-refusal-transport.js');
        await expect(sendThroughConnectionManager(reply)).resolves.toEqual(reply);
    });
});
