import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
// The production helper is plain JavaScript and side-effect-free on import.
// @ts-expect-error JavaScript helper intentionally has no declaration file.
const helper = () => import('../../scripts/sandbox-checkout-return.mjs');
it('acceptance entrypoint uses owned checkout helper and closes in finally', () => {
 const source=readFileSync(new URL('../../scripts/test-sandbox.mjs',import.meta.url),'utf8');
 expect(source).toContain('createAcceptanceCheckout');
 expect(source).toMatch(/finally\s*\{[^}]*landing\?\.close/s);
});
it('actual acceptance payload has ephemeral loopback callbacks and PAY_NOW; closes on success',async()=>{
 const {createAcceptanceCheckout}=await helper();const landing=await createAcceptanceCheckout();
 const origin=new URL(landing.body('run','SELLER123',{currency_code:'USD',value:'1.00'}).payment_source.paypal.experience_context.return_url).origin;
 try {
 const body=landing.body('run','SELLER123',{currency_code:'USD',value:'1.00'}),ctx=body.payment_source.paypal.experience_context;
 for(const field of ['return_url','cancel_url']){const u=new URL(ctx[field]);expect(u.hostname).toBe('127.0.0.1');expect(+u.port).toBeGreaterThan(0);expect(u.searchParams.get('state')).toBeTruthy();}
 expect(ctx.user_action).toBe('PAY_NOW');expect(body.purchase_units[0].amount.value).toBe('1.00');
 }finally{await landing.close();}
 await expect(fetch(origin)).rejects.toThrow();
});
it('landing rejects forged navigation, never declares authenticated approval, and latches cancellation',async()=>{
 const {createAcceptanceCheckout}=await helper();const landing=await createAcceptanceCheckout();
 const ctx=landing.body('run','SELLER123',{}).payment_source.paypal.experience_context;
 const valid=ctx.return_url+'&token=ORDER123';landing.bindOrder('ORDER123');
 try {
 for(const url of [ctx.return_url,valid+'&token=OTHER',valid+'&state=other',valid.replace('ORDER123','OTHER'),valid.replace('/return','/unknown'),valid.replace(/state=[^&]+/,'state=wrong')])expect((await fetch(url)).status).toBe(400);
 expect((await fetch(valid,{method:'POST'})).status).toBe(400);
 const wrongHost=await new Promise<number>(resolve=>{const r=request(valid,{headers:{host:'localhost'}},res=>{res.resume();resolve(res.statusCode!);});r.end();});expect(wrongHost).toBe(400);
 for(let i=0;i<2;i++){const res=await fetch(valid+'&PayerID=untrusted');expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.text()).toContain('Approval return received');}
 const cancelled=await fetch(ctx.cancel_url+'&token=ORDER123');expect(await cancelled.text()).toContain('Cancelled');expect(()=>landing.assertNotCancelled()).toThrow('CHECKOUT_CANCELLED');
 }finally{await landing.close();}
 await expect(fetch(valid)).rejects.toThrow();
});
it('bind failure fails before an order can be constructed',async()=>{
 const {createAcceptanceCheckout}=await helper();const server=createServer();server.listen=(()=>{throw new Error('BIND_FAILED');}) as typeof server.listen;
 await expect(createAcceptanceCheckout({server})).rejects.toThrow('BIND_FAILED');expect(server.listening).toBe(false);
});
it.each(['error','interrupt'])('owned listener closes on %s handoff exit',async kind=>{
 const {createAcceptanceCheckout}=await helper();const controller=new AbortController();const landing=await createAcceptanceCheckout({signal:controller.signal});
 const url=landing.body('run','SELLER123',{}).payment_source.paypal.experience_context.return_url;
 try{if(kind==='interrupt')controller.abort();throw new Error('handoff failed');}catch{/* retained ID must be reconciled */}finally{await landing.close();}
 await expect(fetch(url)).rejects.toThrow();
});
