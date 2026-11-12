import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, jest, test } from '@jest/globals';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const managerSource = read('../public/scripts/extensions/connection-manager/index.js');
const slashSource = read('../public/scripts/slash-commands.js');

function extractFunction(source, name) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, 'm'));
    if (!match) throw new Error(`Missing function ${name}`);
    return match[0];
}

function extractClass(path, name) {
    const match = read(path).match(new RegExp(`^export class ${name} \\{[^]*?^\\}`, 'm'));
    if (!match) throw new Error(`Missing class ${name}`);
    return match[0].replace(/^export /, '');
}

function profileHarness() {
    const settings = {
        chat_completion_source: 'vertexai',
        vertexai_auth_mode: 'express',
        vertexai_express_project_id: 'project-a',
        vertexai_region: 'global',
    };
    const events = [];
    const context = {
        main_api: 'openai',
        oai_settings: settings,
        chat_completion_sources: { VERTEXAI: 'vertexai' },
        isTrueBoolean: value => value === 'true',
        console,
        EMPTY: '<Empty>',
        getSecretLabelById: () => '',
        extension_settings: {},
        SlashCommandParser: { commands: {} },
        getNamedArguments: (args = {}) => ({ quiet: 'true', ...args }),
        ConnectionManagerSpinner: class {
            static abort() {}
            start() {}
            stop() {}
            isAborted() { return false; }
        },
        $: selector => {
            let value;
            return {
                val(next) { value = next; return this; },
                trigger(event) {
                    events.push([selector, event]);
                    settings[selector.slice(1)] = value;
                },
            };
        },
    };
    const constants = managerSource.slice(managerSource.indexOf('const ALLOW_EMPTY'), managerSource.indexOf('/**\n * A wrapper'));
    const functions = ['readProfileFromCommands', 'applyConnectionProfile', 'makeFancyProfile']
        .map(name => extractFunction(managerSource, name)).join('\n');
    const callbacks = ['setVertexAIAuthModeCallback', 'setVertexAIProjectIdCallback']
        .map(name => extractFunction(slashSource, name)).join('\n');
    const api = runInNewContext(`${constants}\n${functions}\n${callbacks}\n({
        readProfileFromCommands, applyConnectionProfile, makeFancyProfile,
        setVertexAIAuthModeCallback, setVertexAIProjectIdCallback, CC_COMMANDS,
    });`, context);
    const commands = context.SlashCommandParser.commands;
    for (const name of api.CC_COMMANDS) commands[name] = { callback: async () => undefined };
    commands['api'].callback = async (_args, value) => {
        if (value) settings.chat_completion_source = value;
        return settings.chat_completion_source;
    };
    commands['api-url'].callback = async (_args, value) => {
        if (value) settings.vertexai_region = value;
        return settings.vertexai_region;
    };
    commands['vertexai-auth-mode'].callback = api.setVertexAIAuthModeCallback;
    commands['vertexai-project-id'].callback = api.setVertexAIProjectIdCallback;
    return { ...api, settings, commands, events };
}

describe('Vertex connection profile persistence', () => {
    test('round-trips two connections sharing a preset and restores fields after the preset', async () => {
        const h = profileHarness();
        const first = { mode: 'cc', preset: 'shared' };
        await h.readProfileFromCommands('cc', first);
        expect(first).toMatchObject({ 'vertexai-auth-mode': 'express', 'vertexai-project-id': 'project-a', 'api-url': 'global' });
        Object.assign(h.settings, { vertexai_auth_mode: 'full', vertexai_express_project_id: '', vertexai_region: 'europe-west1' });
        const second = { mode: 'cc', preset: 'shared' };
        await h.readProfileFromCommands('cc', second);
        expect(second['vertexai-project-id']).toBe('');
        h.commands.preset.callback = async () => Object.assign(h.settings, {
            chat_completion_source: 'makersuite', vertexai_auth_mode: 'express',
            vertexai_express_project_id: 'preset-project', vertexai_region: 'us-central1',
        });
        await h.applyConnectionProfile(JSON.parse(JSON.stringify(first)));
        expect(h.settings).toMatchObject({ chat_completion_source: 'vertexai', vertexai_auth_mode: 'express', vertexai_express_project_id: 'project-a', vertexai_region: 'global' });
        await h.applyConnectionProfile(JSON.parse(JSON.stringify(second)));
        expect(h.settings).toMatchObject({ chat_completion_source: 'vertexai', vertexai_auth_mode: 'full', vertexai_express_project_id: '', vertexai_region: 'europe-west1' });
        expect(h.events).toContainEqual(['#vertexai_auth_mode', 'change']);
        expect(h.events).toContainEqual(['#vertexai_express_project_id', 'input']);
        expect(h.makeFancyProfile(second)).toMatchObject({ 'Vertex AI Project ID': '<Empty>', 'Vertex AI Authentication Mode': 'full' });
    });

    test('updates an existing project to empty instead of keeping the old value', async () => {
        const h = profileHarness();
        const profile = { mode: 'cc' };
        await h.readProfileFromCommands('cc', profile);
        h.settings.vertexai_express_project_id = '';
        await h.readProfileFromCommands('cc', profile, true);
        expect(profile['vertexai-project-id']).toBe('');
    });

    test('leaves legacy profiles and excluded fields compatible', async () => {
        const h = profileHarness();
        await h.applyConnectionProfile({ mode: 'cc', api: 'vertexai', 'api-url': 'europe-west1' });
        expect(h.settings.vertexai_express_project_id).toBe('project-a');
        expect(h.settings.vertexai_auth_mode).toBe('express');
        const profile = { mode: 'cc', exclude: ['vertexai-auth-mode', 'vertexai-project-id'] };
        await h.readProfileFromCommands('cc', profile);
        expect(profile).not.toHaveProperty('vertexai-project-id');
        expect(profile).not.toHaveProperty('vertexai-auth-mode');
    });

    test('does not capture or apply Vertex fields for another provider and cleans up on update', async () => {
        const h = profileHarness();
        const profile = { mode: 'cc' };
        await h.readProfileFromCommands('cc', profile);
        h.settings.chat_completion_source = 'makersuite';
        await h.readProfileFromCommands('cc', profile, true);
        expect(profile).not.toHaveProperty('vertexai-project-id');
        expect(profile).not.toHaveProperty('vertexai-auth-mode');
        await h.applyConnectionProfile({ mode: 'cc', api: 'makersuite', 'vertexai-project-id': 'stale', 'vertexai-auth-mode': 'full' });
        expect(h.settings.vertexai_express_project_id).toBe('project-a');
        expect(h.settings.vertexai_auth_mode).toBe('express');
    });

    test('rejects invalid authentication modes before changing settings', () => {
        const h = profileHarness();
        expect(() => h.setVertexAIAuthModeCallback({}, 'invalid')).toThrow('expected express or full');
        expect(h.events).toEqual([]);
    });
});

function requestHarness(profile) {
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const settings = { vertexai_auth_mode: 'express', vertexai_express_project_id: 'global-project', vertexai_region: 'global' };
    const preset = { vertexai_auth_mode: 'full', vertexai_express_project_id: 'preset-project', vertexai_region: 'us-central1' };
    const context = {
        fetch, AbortController, structuredClone, console,
        proxies: [],
        getRequestHeaders: () => ({}),
        oai_settings: settings,
        settingsToUpdate: Object.fromEntries(Object.keys(settings).map(key => [key, ['', key]])),
        getPresetManager: () => ({ getCompletionPresetByName: () => preset }),
        createGenerationParameters: async settings => ({ generate_data: { ...settings } }),
    };
    const classes = extractClass('../public/scripts/custom-request.js', 'ChatCompletionService') + '\n'
        + extractClass('../public/scripts/extensions/shared.js', 'ConnectionManagerRequestService');
    const api = runInNewContext(`${classes}\n({ ChatCompletionService, ConnectionManagerRequestService });`, context);
    context.SillyTavern = { getContext: () => ({ extensionSettings: { disabledExtensions: [] }, ChatCompletionService: api.ChatCompletionService }) };
    api.ConnectionManagerRequestService.getProfile = () => profile;
    api.ConnectionManagerRequestService.validateProfile = () => ({ selected: 'openai', source: profile.api });
    return async (includePreset = true, overrides = {}) => {
        await api.ConnectionManagerRequestService.sendRequest('profile', 'Synthetic prompt', 128, { includePreset, extractData: false }, overrides);
        return JSON.parse(fetch.mock.calls.at(-1)[1].body);
    };
}

describe('Vertex extension request payloads', () => {
    test.each([true, false])('uses the profile project, auth mode and region with includePreset=%s', async includePreset => {
        const send = requestHarness({ api: 'vertexai', preset: 'shared', 'vertexai-auth-mode': 'express', 'vertexai-project-id': 'profile-project', 'api-url': 'europe-west1' });
        expect(await send(includePreset)).toMatchObject({ vertexai_auth_mode: 'express', vertexai_express_project_id: 'profile-project', vertexai_region: 'europe-west1' });
    });

    test.each([true, false])('keeps an explicit empty project with includePreset=%s', async includePreset => {
        const send = requestHarness({ api: 'vertexai', preset: 'shared', 'vertexai-auth-mode': 'full', 'vertexai-project-id': '' });
        expect(await send(includePreset)).toMatchObject({ vertexai_auth_mode: 'full', vertexai_express_project_id: '' });
    });

    test('retains preset fallback for legacy profiles', async () => {
        const send = requestHarness({ api: 'vertexai', preset: 'shared' });
        expect(await send()).toMatchObject({ vertexai_auth_mode: 'full', vertexai_express_project_id: 'preset-project' });
        const withoutPreset = await send(false);
        expect(withoutPreset).not.toHaveProperty('vertexai_auth_mode');
        expect(withoutPreset).not.toHaveProperty('vertexai_express_project_id');
    });

    test('lets explicit caller overrides take precedence', async () => {
        const send = requestHarness({ api: 'vertexai', preset: 'shared', 'vertexai-project-id': 'profile-project', 'vertexai-auth-mode': 'full' });
        expect(await send(true, { vertexai_express_project_id: '', vertexai_auth_mode: 'express' })).toMatchObject({ vertexai_express_project_id: '', vertexai_auth_mode: 'express' });
    });

    test('does not send stale Vertex profile fields to other providers', async () => {
        const send = requestHarness({ api: 'makersuite', 'vertexai-project-id': 'stale', 'vertexai-auth-mode': 'full' });
        const body = await send(false);
        expect(body).not.toHaveProperty('vertexai_auth_mode');
        expect(body).not.toHaveProperty('vertexai_express_project_id');
    });
});
