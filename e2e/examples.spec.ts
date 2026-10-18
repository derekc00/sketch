import { test, expect } from '@playwright/test';
import { loadExample } from './helpers/load-example';

test.describe('Machine fixtures through editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.getByTestId('code-editor')).toBeVisible();
  });

  test('loads Traffic Light example', async ({ page }) => {
    await loadExample(page, 'Traffic Light');

    await expect(page.getByTestId('machine-name')).toHaveText('trafficLight');
    await expect(
      page.locator('[data-state-id="trafficLight.green"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="trafficLight.yellow"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="trafficLight.red"]'),
    ).toBeVisible();
  });

  test('loads Vending Machine example (JSON format)', async ({ page }) => {
    await loadExample(page, 'Vending Machine');

    await expect(page.getByTestId('machine-name')).toHaveText('vendingMachine');
    await expect(
      page.locator('[data-state-id="vendingMachine.idle"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="vendingMachine.hasCredit"]'),
    ).toBeVisible();

    await expect(page.getByTestId('format-badge')).toHaveText('JSON');
  });

  test('simulates Counter example and shows assigned state and context', async ({
    page,
  }) => {
    await loadExample(page, 'Counter');

    await expect(page.getByTestId('machine-name')).toHaveText('counter');
    await page.getByRole('tab', { name: 'Simulation' }).click();
    await expect(page.getByTestId('simulation-state')).toContainText('"active"');
    await expect(page.getByTestId('simulation-context')).toContainText('"count": 0');

    await page.getByRole('button', { name: 'Start simulation from panel' }).click();

    const contextPanel = page.getByTestId('simulation-context');
    await expect(page.getByTestId('simulation-state')).toContainText('"active"');
    await expect(contextPanel).toContainText('"count": 0');
    await expect(contextPanel).toContainText('"step": 1');

    await page.getByTestId('transition-event').filter({ hasText: 'INC' }).click();
    await expect(contextPanel).toContainText('"count": 1');

    await page.getByTestId('transition-event').filter({ hasText: 'STEP_5' }).click();
    await expect(contextPanel).toContainText('"step": 5');

    await page.getByTestId('transition-event').filter({ hasText: 'INC' }).click();
    await expect(contextPanel).toContainText('"count": 6');

    await page.getByTestId('transition-event').filter({ hasText: 'RESET' }).click();
    await expect(contextPanel).toContainText('"count": 0');
    await expect(contextPanel).toContainText('"step": 1');
  });

  test('loads Promise example (YAML format)', async ({ page }) => {
    await loadExample(page, 'Promise');

    await expect(page.getByTestId('machine-name')).toHaveText('promise');
    await expect(
      page.locator('[data-state-id="promise.pending"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="promise.resolved"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="promise.rejected"]'),
    ).toBeVisible();

    await expect(page.getByTestId('format-badge')).toHaveText('YAML');
  });

  test('loads Authentication example with nested states', async ({ page }) => {
    await loadExample(page, 'Authentication');

    await expect(page.getByTestId('machine-name')).toHaveText('auth');
    await expect(
      page.locator('[data-state-id="auth.loggedOut"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="auth.loggedIn"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="auth.loggedOut.idle"]'),
    ).toBeVisible();
  });

  test('loads Door Lock example (Mermaid state diagram)', async ({ page }) => {
    await loadExample(page, 'Door Lock');

    await expect(page.getByTestId('machine-name')).toHaveText('machine');
    await expect(
      page.locator('[data-state-id="machine.Locked"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="machine.Unlocked"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="machine.Open"]'),
    ).toBeVisible();

    await expect(page.getByTestId('format-badge')).toHaveText('Mermaid');
  });

  test('loads Order Process example (Mermaid flowchart)', async ({ page }) => {
    await loadExample(page, 'Order Process');

    await expect(page.getByTestId('machine-name')).toHaveText('machine');
    await expect(
      page.locator('[data-state-id="machine.Pending"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-state-id="machine.Processing"]'),
    ).toBeVisible();

    await expect(page.getByTestId('format-badge')).toHaveText('Mermaid');
  });

  test('can simulate Traffic Light example', async ({ page }) => {
    await loadExample(page, 'Traffic Light');
    await expect(page.getByTestId('machine-name')).toHaveText('trafficLight');

    await page.getByLabel('Start simulation').click();

    await expect(
      page.locator(
        '[data-state-id="trafficLight.green"] [data-sim-active]',
      ),
    ).toBeVisible();

    // Click NEXT to go to yellow
    await page.locator('text=NEXT').first().click();

    await expect(
      page.locator(
        '[data-state-id="trafficLight.yellow"] [data-sim-active]',
      ),
    ).toBeVisible();
  });

  test('loads Session Timeout example and shows xstate format', async ({ page }) => {
    await loadExample(page, 'Session Timeout');

    await expect(page.getByTestId('machine-name')).toHaveText('sessionTimeout');
    await expect(
      page.locator('[data-state-id="sessionTimeout.active"]'),
    ).toBeVisible();
    await expect(page.getByTestId('format-badge')).toHaveText('XState');
  });
});
