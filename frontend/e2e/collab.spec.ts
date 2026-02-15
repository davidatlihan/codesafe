import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, username: string, room: string): Promise<void> {
  await page.goto(`/?room=${encodeURIComponent(room)}`);
  await page.getByLabel('Username').fill(username);
  await page.getByRole('button', { name: /join room/i }).click();
  await expect(page.getByText('File Explorer')).toBeVisible();
  await expect(page.getByText('Editor')).toBeVisible();
  await expect(page.getByText('Chat')).toBeVisible();
  await expect(page.getByText('Leaderboard')).toBeVisible();
}

test('workspace renders after login', async ({ page }) => {
  await login(page, 'e2e-user-a', 'e2e-login-room');
  await expect(page.getByRole('button', { name: /download project/i })).toBeVisible();
});

test('chat syncs between users in real time', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await login(pageA, 'chat-a', 'e2e-chat-room');
  await login(pageB, 'chat-b', 'e2e-chat-room');

  await pageA.getByPlaceholder('Type message').fill('hello collaborative chat');
  await pageA.getByRole('button', { name: 'Send' }).click();

  await expect(pageB.getByText('hello collaborative chat')).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('collaborative editing, suggestions, and leaderboard update', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await login(pageA, 'editor-a', 'e2e-collab-room');
  await login(pageB, 'editor-b', 'e2e-collab-room');

  const editorTextareaA = pageA.locator('.monaco-editor textarea').first();
  const editorTextareaB = pageB.locator('.monaco-editor textarea').first();

  await editorTextareaA.click();
  await pageA.keyboard.type('const sharedValue = 42;');

  await expect(pageB.locator('.view-lines')).toContainText('sharedValue');

  await pageA.keyboard.press('ControlOrMeta+A');
  await pageA.getByRole('button', { name: 'Capture Selection' }).click();
  await pageA.getByPlaceholder('Write suggestion').fill('Consider renaming sharedValue for clarity');
  await pageA.getByRole('button', { name: 'Submit' }).click();

  await expect(pageB.getByText('Consider renaming sharedValue for clarity')).toBeVisible();

  await editorTextareaB.click();
  await pageB.keyboard.type(' // second user change');

  await expect(pageA.locator('.leaderboard-list')).toContainText('typed:');
  await expect(pageA.locator('.leaderboard-list')).toContainText('editor-a');

  await contextA.close();
  await contextB.close();
});
