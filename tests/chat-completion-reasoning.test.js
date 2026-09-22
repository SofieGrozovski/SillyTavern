import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from '@jest/globals';

// openai.js imports the browser UI. Execute its actual message classes in isolation,
// replacing only token counting so these serialization tests need no browser or API.
const source = readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const classNames = ['Message', 'MessageCollection', 'ChatCompletion'];
const classes = classNames.map(name => {
    const declaration = source.match(new RegExp(`^(?:export )?class ${name} \\{[\\s\\S]*?^\\}`, 'm'));
    if (!declaration) throw new Error(`Missing class ${name} in openai.js`);
    return declaration[0].replace(/^export /, '');
}).join('\n');
const { Message, MessageCollection, ChatCompletion } = runInNewContext(
    `${classes}\n({ Message, MessageCollection, ChatCompletion });`,
    { tokenHandler: { countAsync: async () => 1 } },
);

describe('ChatCompletion reasoning serialization', () => {
    test('preserves every signed block across sequential tool turns after squashing system messages', async () => {
        const blocksByTurn = [
            [{ type: 'thinking', thinking: 'First thought\n\n', signature: 'first-signature' }],
            [{ type: 'thinking', thinking: '', signature: 'omitted-signature' }],
            [
                { type: 'redacted_thinking', data: 'opaque-data' },
                { type: 'thinking', thinking: 'Follow-up thought', signature: 'follow-up-signature' },
            ],
        ];
        const completion = new ChatCompletion();
        const history = new MessageCollection('chatHistory');
        history.add(await Message.createAsync('system', 'First instruction', 'system-1'));
        history.add(await Message.createAsync('system', 'Second instruction', 'system-2'));
        history.add(await Message.createAsync('user', 'Look up three things', 'user-1'));

        for (const [index, blocks] of blocksByTurn.entries()) {
            const id = `tool-${index}`;
            const call = await Message.createAsync('assistant', undefined, `call-${index}`);
            await call.setToolCalls([{
                id,
                name: 'lookup',
                parameters: '{}',
                reasoning_blocks: blocks,
            }], false, { includeReasoning: true, replayReasoningBlocks: true });
            history.add(call);
            history.add(await Message.createAsync('tool', `Result ${index}`, id));
        }
        completion.messages.add(history);

        const before = completion.getChat();
        expect(before.filter(message => message.tool_calls).map(message => message.reasoning_blocks)).toEqual(blocksByTurn);

        await completion.squashSystemMessages();
        const after = completion.getChat();
        expect(after[0]).toEqual({ role: 'system', content: 'First instruction\nSecond instruction' });
        expect(after.filter(message => message.tool_calls).map(message => message.reasoning_blocks)).toEqual(blocksByTurn);
        expect(after.slice(1)).toEqual(before.slice(2));
    });

    test('keeps plaintext reasoning and signatures after squashing', async () => {
        const completion = new ChatCompletion();
        const history = new MessageCollection('chatHistory');
        const message = await Message.createAsync('assistant', 'Answer', 'answer');
        message.reasoning = 'Plaintext thought';
        message.signature = 'text-signature';
        history.add(message);
        completion.messages.add(history);

        await completion.squashSystemMessages();

        expect(completion.getChat()).toEqual([{
            role: 'assistant',
            content: 'Answer',
            reasoning: 'Plaintext thought',
            signature: 'text-signature',
        }]);
    });

    test.each([[null], [[]]])('omits absent or empty reasoning blocks (%j)', async blocks => {
        const completion = new ChatCompletion();
        const history = new MessageCollection('chatHistory');
        const message = await Message.createAsync('assistant', 'Answer', 'answer');
        message.reasoning_blocks = blocks;
        history.add(message);
        completion.messages.add(history);

        await completion.squashSystemMessages();

        expect(completion.getChat()).toEqual([{ role: 'assistant', content: 'Answer' }]);
    });
});
