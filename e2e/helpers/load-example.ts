import { expect, type Page } from '@playwright/test';
import { examples } from '../../src/lib/examples';

export async function loadExample(page: Page, title: string) {
  const example = examples.find((item) => item.title === title);
  if (!example) throw new Error(`Missing fixture: ${title}`);

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await expect(page.getByTestId('code-editor')).toBeVisible();
  await page.evaluate((code) => navigator.clipboard.writeText(code), example.code);
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+v');
  await page.getByTestId('update-button').click();
}
