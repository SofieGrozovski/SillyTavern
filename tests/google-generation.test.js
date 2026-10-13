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

describe.each(['makersuite', 'vertexai'])('Gemini 4 Argon requests through %s', provider => {
    test('sends thinking levels, omits sampling, and uses the correct API route', async () => {
        const { url, headers, body } = await invoke(generate, { chat_completion_source: provider });
        expect(url).toContain('/models/gemini-4-argon:generateContent');
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
        const { body } = await invoke(generate, { chat_completion_source: provider, reasoning_effort: 'auto', include_reasoning: false });
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: false });
    });

    test('keeps system instructions and structured output', async () => {
        const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
        const { body } = await invoke(generate, {
            chat_completion_source: provider,
            use_sysprompt: true,
            messages: [{ role: 'system', content: 'Be concise' }, { role: 'user', content: 'Hello' }],
            json_schema: { name: 'answer', value: schema },
        });
        expect(body.systemInstruction.parts).toEqual([{ text: 'Be concise' }]);
        expect(body.generationConfig.responseMimeType).toBe('application/json');
        expect(body.generationConfig.responseSchema).toEqual(schema);
    });

    test('preserves signed tool history and supplies a fallback for imported calls', async () => {
        const call = (id, signature) => ({ id, type: 'function', function: { name: 'lookup', arguments: '{"query":"x"}' }, signature });
        const { body } = await invoke(generate, {
            chat_completion_source: provider,
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
            chat_completion_source: provider,
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

    test.each([[false, 32768], [true, 65536]])('limits output for stream=%s to %s tokens', async (stream, limit) => {
        const { url, body } = await invoke(generate, { chat_completion_source: provider, stream, max_tokens: 200000 });
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
