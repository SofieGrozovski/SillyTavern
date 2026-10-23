import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the real browser request services with only transport/UI dependencies
// replaced. No live browser, credentials, or external API requests are used.
export async function sendThroughConnectionManager(body, source = 'claude') {
    function loadClass(file, name) {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        const match = source.match(new RegExp('^export class ' + name + ' \\{[\\s\\S]*?^\\}', 'm'));
        if (!match) throw new Error('Missing class ' + name);
        return match[0].replace(/^export /, '');
    }
    const context = {
        AbortController,
        fetch: async () => ({ ok: true, json: async () => body }),
        getRequestHeaders: () => ({}),
        proxies: [],
    };
    const classes = loadClass('../public/scripts/custom-request.js', 'ChatCompletionService') + '\n'
        + loadClass('../public/scripts/extensions/shared.js', 'ConnectionManagerRequestService');
    const { ChatCompletionService, ConnectionManagerRequestService } = runInNewContext(
        classes + '\n({ ChatCompletionService, ConnectionManagerRequestService });', context,
    );
    context.SillyTavern = { getContext: () => ({ extensionSettings: { disabledExtensions: [] }, ChatCompletionService }) };
    ConnectionManagerRequestService.getProfile = () => ({ model: 'synthetic-model' });
    ConnectionManagerRequestService.validateProfile = () => ({ selected: 'openai', source });
    return ConnectionManagerRequestService.sendRequest('synthetic-profile', [{ role: 'user', content: 'A test.' }], 128,
        { includePreset: false, extractData: false, stream: false });
}
