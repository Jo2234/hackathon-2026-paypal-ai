// Multiprocess claim helper. Never launched by module import.
import { appendFileSync } from 'node:fs';
import { TestClock } from './clock.ts';
import { openDb,immediate } from '../../src/server/db/db.ts';
import { claimOperation,consumeSendPermit,recoverExpiredSending } from '../../src/server/operations.ts';
const [path,id,nowText,callFile,mode]=process.argv.slice(2);
if(!path || !id || !nowText || !callFile)throw new Error('ARGS');
const now=Number(nowText),db=openDb(path),clock=new TestClock(now);
try {
  if(mode?.startsWith('recover')) {
    const recoveryNow=mode==='recover-early'?now+1:now+30001;
    immediate(db,()=>recoverExpiredSending(db,{wallNow:()=>recoveryNow,monotonicNow:()=>0}));
    const permit=await claimOperation(db,id,{sessionDeadlineMono:60000,sessionExpiresAt:now+60000},{clock});
    if(permit)throw new Error('RECOVERY_POST_TAKEOVER');
    process.send?.({kind:'recovered'});
  } else {
    const permit=await claimOperation(db,id,{sessionDeadlineMono:60000,sessionExpiresAt:now+60000,approval:{orderId:'ORDER-1',observedAt:now,status:'APPROVED',amountMinor:3999,merchantId:'demo-merchant'}},{clock});
    process.send?.({kind:'claimed',won:permit!==null});
    if(permit) {
      const sendAt=await new Promise<number>(resolve=>process.once('message',message=>resolve((message as {sendAt:number}).sendAt)));
      try {
        clock.advance(sendAt-now);consumeSendPermit(permit);
        appendFileSync(callFile,`${process.pid}\n`); // outbound invocation BEFORE any fake provider dedupe
      } catch(error) { if(!(error instanceof Error) || !error.message.includes('SEND_PERMIT'))throw error; }
    }
  }
} finally {db.close();process.disconnect?.();}
