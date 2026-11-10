import { test, expect } from '@playwright/test';
import { dispatch, expectNoCapture, grossCaptured, openCleanOwner, outcome, read, reviewAndReserve, signManualMandate } from './journey.ts';

test('fixture owner: signed review, agent proposal, simulated approval, confirmed capture/refund and refusal', async ({ page, context }) => {
  // A fixture browser must never navigate to an external payment page.
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort('blockedbyclient');
  });
  await openCleanOwner(page, 'fixture');
  await expect(page.getByRole('status').filter({ hasText: 'PayPal fixture' }).getByText('FIXTURE', { exact: true })).toBeVisible();
  await expect(page.locator('footer')).toContainText('FIXTURE WORKSPACE');
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('01-load.png'),fullPage:true});
  const csrfRefusal=await page.evaluate(async()=>{const r=await fetch('/api/carts/evaluate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});return r.status;});
  expect(csrfRefusal).toBe(403);
  expect((await context.cookies()).some(c=>c.name==='mandate_owner'&&c.httpOnly&&c.sameSite==='Strict')).toBe(true);
  await signManualMandate(page);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('02-signed.png'),fullPage:true});
  const id = await reviewAndReserve(page);
  await expectNoCapture(page, id);
  await page.getByRole('button', { name: 'Prepare simulated checkout', exact: true }).click();
  await dispatch(page, 'ORDER CREATE');
  await expect(outcome(page).getByText('ORDER CREATED', { exact: true })).toBeVisible();
  await expect(outcome(page).getByText('SIMULATED PAYPAL APPROVAL', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Inspect simulated approval details ↗', exact: true })).toHaveAttribute('href', /\/api\/fixtures\/approval\?/);
  await expect(page.getByRole('button', { name: 'Prepare simulated capture', exact: true })).toHaveCount(0);
  await expectNoCapture(page, id);
  const navigationPosts:string[]=[];
  page.on('request',request=>{if(request.method()==='POST')navigationPosts.push(request.url());});
  for(const checkout of ['returned','cancelled']) {
    // Locally mocked sandbox callback/provider envelope; no external navigation.
    await page.route('**/api/**',async route=>{
      if(new URL(route.request().url()).pathname==='/api/paypal/return')return route.fulfill({status:303,headers:{location:`/cart?r=${id}&mode=sandbox&checkout=${checkout}`}});
      const origin=new URL(route.request().url()).origin;
      const res=await route.fetch({headers:{...await route.request().allHeaders(),origin,'sec-fetch-site':'same-origin'}});const data=await res.json();data.mode.paypal='sandbox';
      if(data.reservation){data.reservation.orderId='ORDER123';data.approveUrl='https://www.sandbox.paypal.com/checkoutnow?token=ORDER123';}
      await route.fulfill({response:res,json:data});
    });
    await page.goto('/api/paypal/return');
    await expect(page).toHaveURL(new RegExp(`/cart\\?r=${id}.*checkout=${checkout}`));
    await expect(page.getByRole('status').filter({hasText:checkout==='cancelled'?'Checkout cancelled':'Checkout return received'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Read approval status',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Prepare sandbox capture',exact:true})).toHaveCount(0);
    expect((await read(page,`/api/reservations/${id}`)).body.reservation.id).toBe(id);
    await expectNoCapture(page,id);
    await page.unroute('**/api/**');
  }
  expect(navigationPosts).toEqual([]);
  await page.goto(`/cart?r=${id}`);
  await page.getByRole('button', { name: 'Simulate approval & read status', exact: true }).click();
  await expect(outcome(page).getByText('APPROVED', { exact: true })).toBeVisible();
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('03-approved.png'),fullPage:true});
  await expectNoCapture(page, id);
  await page.getByRole('button', { name: 'Prepare simulated capture', exact: true }).click();
  await expectNoCapture(page, id);

  // Hold server GET evidence after dispatch: the UI must not invent completion
  // from the dispatch acknowledgement. Release in finally to avoid a hung test.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let gated = false;
  await page.route('**/api/**', async route => {
    if (gated && route.request().method() === 'GET') await gate;
    await route.continue();
  });
  gated = true;
  try {
    const acknowledged = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/operations\/[^/]+\/dispatch$/.test(new URL(response.url()).pathname));
    await outcome(page).locator('.operation').filter({ has: page.getByText('ORDER CAPTURE', { exact: true }) })
      .getByRole('button', { name: 'Run simulated operation', exact: true }).click();
    expect((await acknowledged).status()).toBe(202);
    await expect(grossCaptured(page)).toHaveText(/0\.00$/);
    await expect(outcome(page).getByText('CAPTURED', { exact: true })).toHaveCount(0);
  } finally { gated = false; release(); }
  await expect(outcome(page).getByText('CAPTURED', { exact: true })).toBeVisible();
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('04-captured.png'),fullPage:true});
  const captured = await read(page, `/api/reservations/${id}`);
  expect(captured.body.reservation.capturedMinor).toBe(3999);
  await expect(grossCaptured(page)).toHaveText(/39\.99$/);
  const captureLedger = await read(page, '/api/ledger?since=0');
  const capture = captureLedger.body.rows.find((row: any) => row.kind === 'CAPTURE' && row.reservationId === id);
  expect(capture.amountMinor).toBe(3999);
  expect(capture.paypal.captureId).toMatch(/^CAPTURE-/);

  await page.getByText('Request a refund', { exact: true }).click();
  await page.getByRole('button', { name: 'Start refund draft for this reservation', exact: true }).click();
  await page.getByLabel('Retained capture', { exact: true }).selectOption(capture.paypal.captureId);
  await page.getByLabel('Refund amount · USD', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Prepare simulated refund intent', exact: true }).click();
  await dispatch(page, 'REFUND CREATE');
  const refunded = await read(page, `/api/reservations/${id}`);
  expect(refunded.body.refunds).toHaveLength(1);
  expect(refunded.body.refunds[0]).toMatchObject({ state: 'COMPLETED', amount: 3999, captureId: capture.paypal.captureId });
  await expect(outcome(page).getByText(/39\.99.*COMPLETED.*capture/)).toBeVisible();
  await expect(outcome(page).getByText('REFUNDED', { exact: true })).toBeVisible();
  await expect(grossCaptured(page)).toHaveText(/39\.99$/); // Gross facts survive refund.
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('05-refunded.png'),fullPage:true});
  const beforeRefusal = await read(page, '/api/ledger?since=0');
  expect(beforeRefusal.body.rows.some((row: any) => row.kind === 'REFUND_DONE')).toBe(true);
  const beforeReservation = await read(page, `/api/reservations/${id}`);
  const mutationPaths: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') mutationPaths.push(new URL(request.url()).pathname); });
  await page.getByLabel('Item', { exact: true }).selectOption('COF-001');
  await page.getByLabel('Quantity', { exact: true }).fill('5'); // $67.50 > signed $50 order max.
  await page.getByRole('button', { name: 'Evaluate manual cart', exact: true }).click();
  await expect(page.getByText(/R10_ORDER_MAX:/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Reserve / })).toBeDisabled();
  const afterRefusal = await read(page, '/api/ledger?since=0');
  expect(afterRefusal.body.rows.filter((row: any) => row.kind === 'CAPTURE'))
    .toEqual(beforeRefusal.body.rows.filter((row: any) => row.kind === 'CAPTURE'));
  expect((await read(page, `/api/reservations/${id}`)).body.reservation).toEqual(beforeReservation.body.reservation);
  expect(mutationPaths).toEqual(['/api/carts/evaluate']);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:test.info().outputPath('06-refused.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  if ((page.viewportSize()?.width ?? 0) > 850) {
    expect(await page.locator('.sidebar').evaluate(el=>Math.ceil(el.getBoundingClientRect().height) >= document.documentElement.scrollHeight)).toBe(true);
  }
  await expect(page.locator('footer')).toContainText('FIXTURE WORKSPACE');


});
