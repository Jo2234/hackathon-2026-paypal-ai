import { test, expect } from '@playwright/test';
import { dispatch, expectNoCapture, openCleanOwner, outcome, reviewAndReserve, signManualMandate } from './journey.ts';

test('sandbox: no capture before confirmation; stop at real PayPal approval for a human', async ({ page, context }) => {
  test.skip(process.env.RUN_SANDBOX_HUMAN !== '1', 'Explicit human opt-in required; creates a sandbox order.');
  test.setTimeout(0); // Human handoff has no automatic approval or completion deadline.
  test.info().annotations.push({ type: 'boundary', description: 'Stops at buyer approval. Does not prove capture/refund or L01–L06 acceptance.' });
  // Context starts without inherited app or PayPal authentication.
  expect(await context.cookies()).toEqual([]);
  await openCleanOwner(page, 'sandbox');
  await signManualMandate(page);
  const id = await reviewAndReserve(page, false);
  await expectNoCapture(page, id);
  await page.getByRole('button', { name: 'Prepare sandbox checkout', exact: true }).click();
  await dispatch(page, 'ORDER CREATE');
  await expect(outcome(page).getByText('ORDER CREATED', { exact: true })).toBeVisible();
  await expect(outcome(page).getByText('PAYPAL SANDBOX BUYER APPROVAL', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simulate approval & read status', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare sandbox capture', exact: true })).toHaveCount(0);
  await expectNoCapture(page, id);
  const approval = page.getByRole('link', { name: 'Approve on PayPal sandbox ↗', exact: true });
  const href = await approval.getAttribute('href');
  expect(href).toBeTruthy();
  const destination = new URL(href!);
  expect(destination.protocol).toBe('https:');
  expect(destination.hostname).toBe('www.sandbox.paypal.com');
  expect(destination.username).toBe('');
  expect(destination.password).toBe('');
  const popupPromise = page.waitForEvent('popup');
  await approval.click();
  const paypal = await popupPromise;
  await paypal.waitForURL(url => url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com');
  await paypal.waitForLoadState('domcontentloaded');
  // External page internals are deliberately not automated or asserted from guessed text.
  // App continues to show zero capture while the actual provider page is open.
  await expectNoCapture(page, id);
  await page.pause(); // HUMAN: inspect PayPal page; no credentials/approval entered by this test.
  // Resume ends this bounded suite, without clicking approval, reconcile, capture or refund.
});
