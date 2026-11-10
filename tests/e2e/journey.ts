import { expect, type Page, type Locator } from '@playwright/test';

export function outcome(page: Page): Locator {
  return page.getByRole('heading', { name: 'Follow the evidence.', exact: true }).locator('..').locator('..');
}
export function grossCaptured(page: Page): Locator {
  return page.getByRole('region', { name: 'Server budget counters' }).getByRole('article')
    .filter({ has: page.getByText('Gross captured', { exact: true }) }).locator('strong');
}
export async function read(page: Page, path: string) {
  // Browser-origin GET preserves LocalSession's Fetch-Site/cookie contract.
  return page.evaluate(async path => {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, path);
}
export async function openCleanOwner(page: Page, mode: 'fixture' | 'sandbox') {
  await page.goto('/mandate');
  await expect(page.getByRole('button', { name: 'Edit manually', exact: true })).toBeEnabled();
  const health = await read(page, '/api/health');
  expect(health.status).toBe(200);
  expect(health.body.mode.paypal).toBe(mode); // Fail before any payment mutation in wrong mode.
  const current = await read(page, '/api/mandates/current');
  expect(current.status, 'Use a fresh isolated DB; browser isolation does not reset the ledger').toBe(404);
  const ledger = await read(page, '/api/ledger?since=0');
  expect(ledger.status).toBe(200);
  expect(ledger.body.rows).toEqual([]);
  await expect(page.getByRole('status').filter({ hasText: mode === 'fixture' ? 'PayPal fixture · no PayPal calls' : 'PayPal sandbox · synthetic catalogue' })).toBeVisible();
}
export async function signManualMandate(page: Page) {
  await page.getByRole('button', { name: 'Edit manually', exact: true }).click();
  await page.getByLabel('Per-order maximum · USD', { exact: true }).fill('50.00');
  await expect(page.getByRole('table', { name: 'Current edited draft compared with defaults or the replacement baseline' })).toBeVisible();
  await expect(page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'perOrderMaxMinor', exact: true }) })).toContainText('5000');
  await page.getByRole('checkbox', { name: 'I reviewed these exact terms and authorize this local policy.', exact: true }).check();
  await page.getByRole('button', { name: 'Sign reviewed mandate →', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Mandate signed.' })).toBeVisible();
  const signed = await read(page, '/api/mandates/current');
  expect(signed.body.policy.status).toBe('ACTIVE');
  expect(signed.body.policy.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(signed.body.policy.perOrderMaxMinor).toBe(5000);
  // Navigation includes a numeric prefix in the accessible name.
  await page.getByRole('navigation').getByRole('button', { name: /Cart$/ }).click();
}
export async function reviewAndReserve(page: Page, agent = true) {
  if (agent) {
    await page.getByLabel('Request', { exact: true }).fill('Restock coffee and printer cleaning supplies');
    await page.getByRole('button', { name: 'Propose agent cart →', exact: true }).click();
    await page.getByRole('button', { name: 'Review step-up confirmation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm this exact cart', exact: true });
    await expect(dialog).toContainText('COF-001');
    await expect(dialog).toContainText('PRT-004');
    await dialog.getByRole('button', { name: 'Confirm reviewed step-up', exact: true }).click();
  } else {
    await page.getByLabel('Item', { exact: true }).selectOption('COF-001');
    await page.getByLabel('Quantity', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Evaluate manual cart', exact: true }).click();
    await page.getByRole('checkbox', { name: 'I reviewed this exact cart, amount and policy identity.', exact: true }).check();
  }
  await page.getByRole('button', { name: /^Reserve / }).click();
  await expect(outcome(page).getByText('HELD', { exact: true })).toBeVisible();
  const id = await page.getByLabel('Reservation ID', { exact: true }).inputValue();
  expect(id).toMatch(/^[A-Za-z0-9-]{1,128}$/);
  return id;
}
export async function dispatch(page: Page, kind: string) {
  const operation = outcome(page).locator('.operation').filter({ has: page.getByText(kind, { exact: true }) });
  await operation.getByRole('button', { name: /Run (simulated|sandbox) operation/, exact: true }).click();
  await expect(operation.getByText(/^(Simulated|Sandbox) result recorded$/)).toBeVisible();
}
export async function expectNoCapture(page: Page, id: string) {
  const snapshot = await read(page, `/api/reservations/${id}`);
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.reservation.capturedMinor).toBe(0);
  const ledger = await read(page, '/api/ledger?since=0');
  expect(ledger.body.rows.filter((row: any) => row.kind === 'CAPTURE')).toEqual([]);
  await expect(grossCaptured(page)).toHaveText(/0\.00$/);
  await expect(outcome(page).getByText(/Held .*gross captured .*0\.00$/)).toBeVisible();
  await expect(outcome(page).getByText('CAPTURED', { exact: true })).toHaveCount(0);
}
