import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// Navigation hints only. No provider transport, credentials, or money authority.
export async function createAcceptanceCheckout({server=createServer(),signal}={}) {
 const nonce=randomBytes(32).toString('hex');let orderId=null,cancelled=false;
 let authority;
 server.on('request',(req,res)=>{
  res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
  res.setHeader('content-security-policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('content-type','text/html; charset=utf-8');
  let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);res.end('Invalid return');return;}
  const params=url.searchParams;
  if(req.method!=='GET'||req.headers.host!==authority||!['/return','/cancel'].includes(url.pathname)||
    [...params.keys()].some(k=>!['state','token','PayerID'].includes(k)||params.getAll(k).length!==1)||
    params.get('state')!==nonce||!orderId||params.get('token')!==orderId){res.writeHead(400);res.end('Invalid return');return;}
  if(url.pathname==='/cancel')cancelled=true;
  res.end('<!doctype html><meta charset="utf-8"><p>'+ (url.pathname==='/cancel'?'Cancelled — return to the terminal. Reconcile the retained order ID before any further action.':'Approval return received — return to the terminal to verify status.')+'</p>');
 });
 try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
 }catch(error){server.close();throw error;}
 authority=`127.0.0.1:${server.address().port}`;
 const close=async()=>{signal?.removeEventListener('abort',onAbort);server.closeAllConnections();await new Promise(resolve=>server.close(()=>resolve()));};
 const onAbort=()=>{void close();};
 signal?.addEventListener('abort',onAbort,{once:true});
 if(signal?.aborted){await close();signal.throwIfAborted();}
 return {
  body:(id,merchantId,amount)=>({intent:'CAPTURE',purchase_units:[{custom_id:id,invoice_id:id,payee:{merchant_id:merchantId},amount}],payment_source:{paypal:{experience_context:{return_url:`http://${authority}/return?state=${nonce}`,cancel_url:`http://${authority}/cancel?state=${nonce}`,user_action:'PAY_NOW'}}}}),
  bindOrder:id=>{if(orderId)throw new Error('ORDER_ALREADY_BOUND');orderId=id;},
  assertNotCancelled:()=>{if(cancelled)throw new Error('CHECKOUT_CANCELLED_RECONCILE_BY_ID');},
  close,
 };
}
