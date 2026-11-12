import { EventEmitter } from 'node:events';
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as actualUtil from '../src/util.js';

// Exercise the real route handlers and prompt conversion without credentials or
// network access. Unrelated tokenizer/user services are not needed for Google.
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
let caption;
beforeAll(async () => {
    const backend = await import('../src/endpoints/backends/chat-completions.js');
    const google = await import('../src/endpoints/google.js');
    generate = backend.router.stack.find(layer => layer.route?.path === '/generate').route.stack[0].handle;
    caption = google.router.stack.find(layer => layer.route?.path === '/caption-image').route.stack[0].handle;
});

beforeEach(() => {
    fetchMock.mockReset();
    forwardMock.mockClear();
    fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'Answer' }] } }] }),
    });
});

async function invoke(handler, overrides = {}) {
    const response = { statusCode: 200 };
    response.status = jest.fn(code => { response.statusCode = code; return response; });
    response.send = jest.fn(() => response);
    response.json = jest.fn(() => response);
    const request = {
        body: {
            chat_completion_source: 'makersuite',
            model: 'gemini-4-argon',
            messages: [{ role: 'user', content: 'Hello' }],
            reverse_proxy: 'https://google-proxy.example',
            proxy_password: 'test-key',
            max_tokens: 8192,
            reasoning_effort: 'medium',
            include_reasoning: true,
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            ...overrides,
        },
        socket: new EventEmitter(),
    };
    await handler(request, response);
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    return { url, headers: options.headers, body: JSON.parse(options.body), response };
}

describe.each(['makersuite', 'vertexai'].flatMap(provider =>
    ['gemini-4-argon', 'gemini-4-carbon', 'gemini-4-hydrogen'].map(model => [provider, model]),
))('%s requests for %s', (provider, model) => {
    test('sends thinking levels, omits sampling, and uses the correct API route', async () => {
        const { url, headers, body } = await invoke(generate, { chat_completion_source: provider, model });
        expect(url).toContain(`/models/${model}:generateContent`);
        if (provider === 'vertexai') {
            expect(url).toContain('/v1/publishers/google/');
            expect(headers.Authorization).toBe('Bearer test-key');
        } else {
            expect(url).toContain('/v1beta/models/');
        }
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'medium' });
        for (const key of ['temperature', 'topP', 'topK', 'candidateCount']) {
            expect(body.generationConfig).not.toHaveProperty(key);
        }
    });

    test('auto leaves the model default thinking level intact', async () => {
        const { body } = await invoke(generate, { chat_completion_source: provider, model, reasoning_effort: 'auto', include_reasoning: false });
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: false });
    });

    test('keeps system instructions and structured output', async () => {
        const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            use_sysprompt: true,
            messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Hello' }],
            json_schema: { name: 'answer', value: schema },
        });
        expect(body.systemInstruction.parts).toEqual([{ text: 'Be concise' }]);
        expect(body.generationConfig.responseMimeType).toBe('application/json');
        expect(body.generationConfig.responseSchema).toEqual(schema);
    });

    test.each([false, true])('preserves JSON Schema tool constraints with stream=%s', async stream => {
        // Reproduces the schema shapes rejected in Vertex's protobuf Schema field:
        // Illustrator's unique image/reference lists and an integer enum.
        const tools = [{
            type: 'function',
            function: {
                name: 'illustrate',
                description: 'Illustrate the scene',
                strict: true,
                parameters: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: {
                        prompt: { type: 'string' },
                        chat_images: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                        edit: { type: 'boolean' },
                        references: { type: 'array', items: { type: 'string' }, uniqueItems: true },
                    },
                    required: ['prompt'],
                    additionalProperties: false,
                },
            },
        }, {
            type: 'function',
            function: {
                name: 'set_rating',
                parameters: {
                    type: 'object',
                    properties: { rating: { type: 'integer', enum: [1, 2, 3, 4, 5] } },
                    required: ['rating'],
                },
            },
        }];
        const original = structuredClone(tools);
        const { body } = await invoke(generate, { chat_completion_source: provider, model, stream, tools });
        const declarations = body.tools[0].function_declarations;
        const expectedImageSchema = structuredClone(original[0].function.parameters);
        delete expectedImageSchema.$schema;
        expect(declarations[0]).toEqual({
            name: 'illustrate', description: 'Illustrate the scene', parametersJsonSchema: expectedImageSchema,
        });
        expect(declarations[1]).toEqual({ name: 'set_rating', parametersJsonSchema: original[1].function.parameters });
        expect(tools).toEqual(original);
    });

    test('preserves nested references, nullable types and schema-keyword property names', async () => {
        const parameters = {
            type: 'object',
            $defs: { choice: { type: ['integer', 'null'], enum: [1, 2, null] } },
            properties: {
                groups: { type: 'array', items: { type: 'object', properties: { choice: { $ref: '#/$defs/choice' } } } },
                uniqueItems: { type: 'boolean' },
                enum: { type: 'string' },
                default: { type: 'string' },
            },
        };
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            tools: [{ type: 'function', function: { name: 'nested', parameters } }],
        });
        expect(body.tools[0].function_declarations[0]).toEqual({ name: 'nested', parametersJsonSchema: parameters });
    });

    test.each([undefined, { type: 'object', properties: {} }])('supports a parameterless tool with schema %j', async parameters => {
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            tools: [{ type: 'function', function: { name: 'get_time', parameters } }],
        });
        const declaration = body.tools[0].function_declarations[0];
        expect(declaration.name).toBe('get_time');
        expect(declaration).not.toHaveProperty('parameters');
        expect(declaration.parametersJsonSchema).toEqual(parameters);
    });

    test('uses an explicit native schema without also sending parameters', async () => {
        const parametersJsonSchema = { type: 'object', properties: { value: { type: 'number', enum: [0.5, 1.5] } } };
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            tools: [{ type: 'function', function: { name: 'native', parametersJsonSchema, parameters: { type: 'object' } } }],
        });
        expect(body.tools[0].function_declarations[0]).toEqual({ name: 'native', parametersJsonSchema });
    });

    test('keeps Google built-in tools unchanged', async () => {
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            tools: [{ type: 'google_search', google_search: {} }],
        });
        expect(body.tools).toEqual([{ google_search: {} }]);
    });

    test('preserves signed tool history and supplies a fallback for imported calls', async () => {
        const call = (id, signature) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' }, signature });
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            messages: [
                { role: 'user', content: 'Look it up' },
                { role: 'assistant', tool_calls: [call('signed', 'original-signature'), call('imported')] },
                { role: 'tool', tool_call_id: 'signed', content: 'First result' },
                { role: 'tool', tool_call_id: 'imported', content: 'Second result' },
            ],
            tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }],
            tool_choice: 'required',
        });
        const parts = body.contents[1].parts;
        expect(body.contents[1].role).toBe('model');
        expect(parts.map(part => part.thoughtSignature)).toEqual(['original-signature', 'skip_thought_signature_validator']);
        expect(parts[0].functionCall).toEqual({ name: 'lookup', args: { query: 'x' } });
        expect(body.contents[2].parts.map(part => part.functionResponse.name)).toEqual(['lookup', 'lookup']);
        expect(body.tools[0].function_declarations[0].name).toBe('lookup');
        expect(body.toolConfig.functionCallingConfig.mode).toBe('ANY');
    });

    test('preserves text signatures and image/video resolution', async () => {
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            messages: [
                { role: 'assistant', content: 'Previous answer', signature: 'text-signature' },
                { role: 'user', content: [
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' } },
                    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,dmlkZW8=', detail: 'low' } },
                    { type: 'audio_url', audio_url: { url: 'data:audio/mpeg;base64,YXVkaW8=' } },
                ] },
            ],
        });
        expect(body.contents[0].parts[0].thoughtSignature).toBe('text-signature');
        expect(body.contents[1].parts).toEqual([
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' }, mediaResolution: { level: 'media_resolution_high' } },
            { inlineData: { mimeType: 'video/mp4', data: 'dmlkZW8=' }, mediaResolution: { level: 'media_resolution_low' } },
            { inlineData: { mimeType: 'audio/mpeg', data: 'YXVkaW8=' } },
        ]);
    });

    test.each([false, true])('keeps user text after tool results in a separate turn with stream=%s', async stream => {
        const { body } = await invoke(generate, {
            chat_completion_source: provider, model,
            stream,
            custom_prompt_post_processing: 'semi_tools',
            messages: [
                { role: 'user', content: 'Look up the status' },
                { role: 'assistant', content: [
                    { type: 'text', text: 'Previous narrative' },
                ], tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
                { role: 'tool', tool_call_id: 'tc1', content: 'Ready' },
                { role: 'system', content: 'Current context' },
                { role: 'user', content: 'New question' },
            ],
            tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
        });
        expect(body.contents.map(content => content.role)).toEqual(['user', 'model', 'user', 'user']);
        expect(body.contents[1].parts).toContainEqual({
            functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'skip_thought_signature_validator',
        });
        expect(body.contents[2].parts).toEqual([
            { functionResponse: { name: 'lookup', response: { name: 'lookup', content: 'Ready' } } },
        ]);
        expect(body.contents[3].parts).toEqual([{ text: 'Current context\n\nNew question' }]);
    });

    test.each([[false, 32768], [true, 65536]])('limits output for stream=%s to %s tokens', async (stream, limit) => {
        const { url, body } = await invoke(generate, { chat_completion_source: provider, model, stream, max_tokens: 200000 });
        expect(body.generationConfig.maxOutputTokens).toBe(limit);
        expect(url).toContain(stream ? ':streamGenerateContent' : ':generateContent');
        expect(forwardMock).toHaveBeenCalledTimes(stream ? 1 : 0);
    });

    test('supports captioning and returns visible text instead of thoughts', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ candidates: [{ content: { parts: [{ thought: true, text: 'Thinking' }, { text: 'A cat.' }] } }] }),
        });
        const { body, response } = await invoke(caption, {
            api: provider === 'vertexai' ? 'vertexai' : 'google',
            model,
            image: 'data:image/png;base64,aW1hZ2U=',
            prompt: 'Describe this image',
        });
        expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/png');
        expect(response.json).toHaveBeenCalledWith({ caption: 'A cat.' });
    });
});

test('Gemini 2.5 retains numeric budgets and sampling', async () => {
    const { body } = await invoke(generate, { model: 'gemini-2.5-pro', max_tokens: 65536 });
    expect(body.generationConfig).toMatchObject({
        maxOutputTokens: 65536, temperature: 0.7, topP: 0.9, topK: 40,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 },
    });
});

test('Gemini 3.8 retains level-based thinking without Argon output limits', async () => {
    const { body } = await invoke(generate, { model: 'gemini-3.8-flash', max_tokens: 65536 });
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('medium');
    expect(body.generationConfig).not.toHaveProperty('temperature');
});


describe.each(['makersuite', 'vertexai'])('Gemini refusal diagnostics through %s', provider => {
    test('preserves a prompt block and its explanation through Connection Manager', async () => {
        const promptFeedback = { blockReason: 'SAFETY', blockReasonMessage: 'Synthetic prompt block.', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', blocked: true }] };
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ promptFeedback, responseId: 'synthetic-block' }) });
        const { response } = await invoke(generate, { chat_completion_source: provider });
        const reply = response.send.mock.calls[0][0];
        expect(reply.error).toMatchObject({ type: 'provider_refusal', provider, reason: 'SAFETY', details: { promptFeedback, responseId: 'synthetic-block' } });
        expect(reply.error.message).toContain('Synthetic prompt block.');
        const { sendThroughConnectionManager } = await import('./provider-refusal-transport.js');
        await expect(sendThroughConnectionManager(reply, provider)).rejects.toMatchObject({ code: 'provider_refusal', message: reply.error.message, details: reply.error });
    });

    test.each(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION', 'MODEL_ARMOR', 'ESCALATION', 'PUP_LIMITED_DISABLED'])(
        'rejects a blocked candidate (%s), even if it contains a partial tool call', async finishReason => {
            fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{
                finishReason, finishMessage: 'Synthetic response block.',
                content: { parts: [{ text: 'Incomplete output' }, { functionCall: { name: 'SillyDice', args: { formula: '1d6' } } }] },
            }] }) });
            const { response } = await invoke(generate, { chat_completion_source: provider });
            const reply = response.send.mock.calls[0][0];
            expect(reply.error).toMatchObject({ type: 'provider_refusal', provider, reason: finishReason, details: { finishReason, finishMessage: 'Synthetic response block.' } });
            expect(reply.error.message).toContain(finishReason);
            expect(reply).not.toHaveProperty('responseContent');
            expect(reply).not.toHaveProperty('choices');
        });

    test('recognizes blocked safety ratings without a finish reason', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ safetyRatings: [{ blocked: true, category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }] }] }) });
        const { response } = await invoke(generate, { chat_completion_source: provider });
        expect(response.send.mock.calls[0][0].error).toMatchObject({ type: 'provider_refusal', reason: 'SAFETY' });
    });

    test('keeps non-refusal finish diagnostics on empty responses', async () => {
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', finishMessage: 'Invalid tool arguments.' }] }) });
        const { response } = await invoke(generate, { chat_completion_source: provider });
        expect(response.send.mock.calls[0][0].error.message).toContain('MALFORMED_FUNCTION_CALL');
        expect(response.send.mock.calls[0][0].error.message).toContain('Invalid tool arguments.');
        expect(response.send.mock.calls[0][0].error.type).toBeUndefined();
    });

    test.each(['STOP', 'MAX_TOKENS'])('does not mistake %s or non-blocking ratings for a refusal', async finishReason => {
        const content = { parts: [{ text: 'Visible answer', thoughtSignature: 'keep-native-signature' }] };
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content, finishReason, safetyRatings: [{ blocked: false }] }], promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } }) });
        const { response } = await invoke(generate, { chat_completion_source: provider });
        const reply = response.send.mock.calls[0][0];
        expect(reply).not.toHaveProperty('error');
        expect(reply).toMatchObject({ responseContent: content, finishReason });
        const { sendThroughConnectionManager } = await import('./provider-refusal-transport.js');
        await expect(sendThroughConnectionManager(reply, provider)).resolves.toEqual(reply);
    });
});
