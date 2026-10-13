import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

// Run the actual frontend capability functions without booting the browser UI.
const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const constants = source.slice(source.indexOf('const max_4k ='), source.indexOf('const oai_max_temp ='));
function capabilities(settings, modelList = []) {
    const names = ['getGeminiMaxContext', 'isImageInliningSupported', 'isVideoInliningSupported', 'isAudioInliningSupported'];
    const functions = names.map(name => {
        const start = source.indexOf(`function ${name}(`);
        return source.slice(start, source.indexOf('\n}', start) + 2);
    });
    return runInNewContext(`${constants}\n${functions.join('\n')}\n({ ${names.join(', ')} });`, {
        main_api: 'openai',
        oai_settings: { media_inlining: true, ...settings },
        chat_completion_sources: CHAT_COMPLETION_SOURCES,
        model_list: modelList,
    });
}

describe.each(['makersuite', 'vertexai'])('Gemini 4 Argon frontend capabilities for %s', provider => {
    const settings = { chat_completion_source: provider, google_model: 'gemini-4-argon', vertexai_model: 'gemini-4-argon' };

    test('uses the full context window when a proxy supplies no model metadata', () => {
        expect(capabilities(settings).getGeminiMaxContext('gemini-4-argon', false)).toBe(1048576);
    });

    test('respects metadata limits and the context unlock setting', () => {
        const api = capabilities(settings, [{ id: 'gemini-4-argon', inputTokenLimit: 500000 }]);
        expect(api.getGeminiMaxContext('gemini-4-argon', false)).toBe(500000);
        expect(api.getGeminiMaxContext('gemini-4-argon', true)).toBe(2000000);
    });

    test('allows image, video and audio attachments', () => {
        const api = capabilities(settings);
        expect(api.isImageInliningSupported()).toBe(true);
        expect(api.isVideoInliningSupported()).toBe(true);
        expect(api.isAudioInliningSupported()).toBe(true);
    });

    test('still respects disabled media inlining', () => {
        const api = capabilities({ ...settings, media_inlining: false });
        expect(api.isImageInliningSupported()).toBe(false);
        expect(api.isVideoInliningSupported()).toBe(false);
        expect(api.isAudioInliningSupported()).toBe(false);
    });
});
