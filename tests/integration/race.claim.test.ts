// Exercises atomic claim contention across child processes for 100 iterations.
import { it,expect } from 'vitest';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync,writeFileSync,appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb,immediate } from '../../src/server/db/db.ts';
import { LedgerService } from '../../src/domain/ledger/service.ts';
import { categoryMap,enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { safeDefaults } from '../../src/domain/policy/policy.ts';
import { reservation,saveReservation } from '../../src/server/db/repo.ts';
import { createOperation,claimOperation,consumeSendPermit } from '../../src/server/operations.ts';
import { assertLedgerInvariants } from '../../src/domain/ledger/invariants.ts';
import { TestClock } from '../helpers/clock.ts';
const now=Date.parse('2026-10-19T01:00:00Z');
function launch(path:string,id:string,calls:string,mode:string) {
  const child=spawn(process.execPath,['--import','tsx',new URL('../helpers/claim-worker.ts',import.meta.url).pathname,path,id,String(now),calls,mode],{stdio:['ignore','pipe','pipe','ipc']});
  let bytes=0;child.stdout?.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>65536)child.kill('SIGTERM');});child.stderr?.on('data',(data:Buffer)=>{bytes+=data.length;if(bytes>65536)child.kill('SIGTERM');});
  const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`child exit ${code}`)));});
  const message=new Promise<{kind:string;won?:boolean}>((resolve,reject)=>{child.once('message',value=>resolve(value as {kind:string;won?:boolean}));child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(new Error(`child before barrier ${code}`));});});
  return {child,done,message};
}
async function stopOwned(children:ChildProcess[]) {
  for(const child of children)if(child.exitCode===null && child.signalCode===null)child.kill('SIGTERM');
  await Promise.all(children.map(child=>child.exitCode!==null || child.signalCode!==null?Promise.resolve():new Promise<void>(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});})));
}
it('F3/F10 original + two contenders/recovery processes never gain two POST permits',async()=>{
  for(let iteration=0;iteration<100;iteration++) {
    const dir=mkdtempSync(join(tmpdir(),'paypal-s1-race-')),path=join(dir,'db.sqlite'),calls=join(dir,'calls');writeFileSync(calls,'');
    const db=openDb(path),children:ChildProcess[]=[];
    try {
      const clock=new TestClock(now),service=new LedgerService(db,enforcementCatalogue,categoryMap,{clock}, 'demo-merchant'),ctx=()=>({ownerId:'owner',key:randomUUID(),session:{expiresAt:now+43200000,deadlineMono:60000}});
      const signed=JSON.parse((await service.sign(ctx(),safeDefaults('owner','m',now),{confirm:true,expectedCurrentHash:null,explicitlyAllowedSensitive:[]})).body) as {policy:{contentHash:string}};
      const reserved=JSON.parse((await service.reserve(ctx(),{proposalId:'race',mandateId:'m',lines:[{sku:'COF-001',qty:2},{sku:'PRT-004',qty:1}],source:{kind:'owner'}},signed.policy.contentHash,true)).body) as {reservation:{id:string}};
      const id=reserved.reservation.id;immediate(db,()=>saveReservation(db,{...reservation(db,id),orderId:'ORDER-1',state:'APPROVED'}));
      const op=immediate(db,()=>createOperation(db,'ORDER_CAPTURE',id,{},now,now+300000));
      const contenders=[launch(path,op.id,calls,'contend'),launch(path,op.id,calls,'contend')];children.push(...contenders.map(x=>x.child));
      const permit=await claimOperation(db,op.id,{sessionDeadlineMono:60000,sessionExpiresAt:now+60000,approval:{orderId:'ORDER-1',observedAt:now,status:'APPROVED',amountMinor:3999,merchantId:'demo-merchant'}},{clock});
      const messages=await Promise.all(contenders.map(x=>x.message));expect(messages.filter(x=>x.won).length+(permit?1:0)).toBe(1);
      const recoverers=[launch(path,op.id,calls,iteration%2===0?'recover-early':'recover'),launch(path,op.id,calls,iteration%2===0?'recover-early':'recover')];children.push(...recoverers.map(x=>x.child));await Promise.all(recoverers.map(x=>x.done));
      const sendAt=iteration%2===0?now+1:now+30001;
      for(const contender of contenders)if(contender.child.connected)contender.child.send({sendAt});
      if(permit) {try {clock.advance(sendAt-now);consumeSendPermit(permit);appendFileSync(calls,`original\n`);}catch(error){if(!(error instanceof Error)||!error.message.includes('SEND_PERMIT'))throw error;}}
      await Promise.all(contenders.map(x=>x.done));
      expect(readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).length).toBeLessThanOrEqual(1);expect(reservation(db,id).holdMinor).toBe(3999);assertLedgerInvariants(db);
    } finally {await stopOwned(children);db.close();rmSync(dir,{recursive:true,force:true});}
  }
},120000);
