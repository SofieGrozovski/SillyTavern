import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

async function openDeleteMode(page, mode = 'selected') {
    await page.evaluate(() => document.querySelector('#option_delete_mes').click());
    await expect(page.locator('#dialogue_del_mes')).toBeVisible();
    await page.locator('#dialogue_del_mes_mode').selectOption(mode);
}

async function deleteSelection(page) {
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('./script.js');
        const deleted = new Promise(resolve => eventSource.once(event_types.MESSAGE_DELETED, resolve));
        document.querySelector('#dialogue_del_mes_ok').click();
        await deleted;
    });
}

async function snapshot(page) {
    return page.evaluate(async () => {
        const { chat } = await import('./script.js');
        return {
            messages: chat.map(message => message.mes),
            ids: [...document.querySelectorAll('#chat > .mes')].map(message => Number(message.getAttribute('mesid'))),
            lastId: document.querySelector('#chat > .last_mes')?.getAttribute('mesid'),
        };
    });
}

test.describe('message deletion modes', () => {
    test.beforeEach(testSetup.awaitST);
    test.beforeEach(async ({ page }) => {
        await page.evaluate(async () => {
            const { addOneMessage, chat, clearChat, newAssistantChat } = await import('./script.js');
            await newAssistantChat({ temporary: true });
            await clearChat({ clearData: true });
            const messages = [
                ['Question A', true],
                ['Tools A', false, true],
                ['Answer A', false],
                ['Question B', true],
                ['Tools B', false, true],
                ['Answer B', false],
                ['Later message', true],
            ];
            for (const [mes, is_user, is_system = false] of messages) {
                const message = {
                    name: is_user ? 'User' : is_system ? 'System' : 'Assistant',
                    mes, is_user, is_system,
                    extra: is_system ? {
                        isSmallSys: true,
                        tool_invocations: [
                            { id: `${mes}-1`, name: 'lookup', parameters: '{}', result: 'First result' },
                            { id: `${mes}-2`, name: 'lookup', parameters: '{}', result: 'Second result' },
                        ],
                    } : {},
                };
                chat.push(message);
                addOneMessage(message);
            }
        });
    });

    test('deletes only nonadjacent selections, including a complete tool block', async ({ page }) => {
        await openDeleteMode(page);
        await expect(page.locator('#dialogue_del_mes_ok')).toBeDisabled();
        await page.locator('.mes[mesid="2"] > .del_checkbox').click();
        await page.locator('.mes[mesid="4"] .mes_text').click();
        await page.locator('.mes[mesid="6"] > .del_checkbox').click();
        await page.locator('.mes[mesid="6"] > .del_checkbox').click();
        await expect(page.locator('#chat > .mes.selected')).toHaveCount(2);
        await expect(page.locator('#dialogue_del_mes_count')).toHaveText('Selected: 2');
        await expect(page.locator('.mes[mesid="6"] > .del_checkbox')).not.toBeChecked();
        await deleteSelection(page);

        expect(await snapshot(page)).toEqual({
            messages: ['Question A', 'Tools A', 'Question B', 'Answer B', 'Later message'],
            ids: [0, 1, 2, 3, 4],
            lastId: '4',
        });
        const invocations = await page.evaluate(async () => (await import('./script.js')).chat[1].extra.tool_invocations);
        expect(invocations).toHaveLength(2);
        await expect(page.locator('#dialogue_del_mes')).toBeHidden();
        await expect(page.locator('#chat > .mes.selected')).toHaveCount(0);
        await expect(page.locator('.mes[mesid="0"] > .del_checkbox')).toBeHidden();
    });

    test('clears selections on mode changes and cancel, and preserves tail deletion', async ({ page }) => {
        await openDeleteMode(page);
        await page.locator('.mes[mesid="2"] > .del_checkbox').click();
        await page.locator('#dialogue_del_mes_mode').selectOption('tail');
        await expect(page.locator('#chat > .mes.selected')).toHaveCount(0);
        await expect(page.locator('#dialogue_del_mes_ok')).toBeDisabled();
        await page.locator('.mes[mesid="5"] > .del_checkbox').click();
        await expect(page.locator('#chat > .mes.selected')).toHaveCount(3);
        await expect(page.locator('.mes[mesid="4"] > .del_checkbox')).toBeChecked();
        await page.locator('#dialogue_del_mes_mode').selectOption('selected');
        await expect(page.locator('#chat > .mes.selected')).toHaveCount(0);
        await page.locator('.mes[mesid="1"] > .del_checkbox').click();
        await page.locator('#dialogue_del_mes_cancel').click();
        expect((await snapshot(page)).messages).toHaveLength(7);

        await openDeleteMode(page, 'tail');
        await expect(page.locator('#dialogue_del_mes_ok')).toBeDisabled();
        await page.locator('.mes[mesid="5"] > .del_checkbox').click();
        await deleteSelection(page);
        expect(await snapshot(page)).toEqual({
            messages: ['Question A', 'Tools A', 'Answer A', 'Question B'],
            ids: [0, 1, 2, 3],
            lastId: '3',
        });
    });

    test('supports loading older messages during selection and reindexes the first visible message', async ({ page }) => {
        await page.evaluate(async () => {
            const { clearChat, printMessages } = await import('./script.js');
            const { power_user } = await import('./scripts/power-user.js');
            await clearChat();
            power_user.chat_truncation = 3;
            await printMessages();
        });
        await openDeleteMode(page);
        await page.locator('.mes[mesid="4"] > .del_checkbox').click();
        await page.locator('#show_more_messages').click();
        await expect(page.locator('.mes[mesid="1"] > .del_checkbox')).toBeVisible();
        await expect(page.locator('.mes[mesid="4"] > .del_checkbox')).toBeChecked();
        await page.locator('.mes[mesid="1"] > .del_checkbox').click();
        await deleteSelection(page);
        expect(await snapshot(page)).toEqual({
            messages: ['Question A', 'Answer A', 'Question B', 'Answer B', 'Later message'],
            ids: [1, 2, 3, 4],
            lastId: '4',
        });
        await page.locator('#show_more_messages').click();
        expect((await snapshot(page)).ids).toEqual([0, 1, 2, 3, 4]);
    });

    test('clears selection when the chat changes and handles deleting the final message', async ({ page }) => {
        await openDeleteMode(page);
        await page.locator('.mes[mesid="0"] > .del_checkbox').click();
        await page.evaluate(async () => (await import('./script.js')).newAssistantChat({ temporary: true }));
        await expect(page.locator('#dialogue_del_mes')).toBeHidden();
        await openDeleteMode(page);
        await expect(page.locator('#dialogue_del_mes_ok')).toBeDisabled();
        await page.locator('.mes[mesid="0"] > .del_checkbox').click();
        await deleteSelection(page);
        expect((await snapshot(page)).messages).toEqual([]);
        await expect(page.locator('#chat > .mes')).toHaveCount(0);
    });
});
