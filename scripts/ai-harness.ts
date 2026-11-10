import { randomUUID } from 'node:crypto';
import { openDb } from '../src/server/db/db.ts';
import { createFixtureApp } from '../src/server/app.ts';
import type { FixtureAppOptions } from '../src/server/app.ts';
import { safeDefaults } from '../src/domain/policy/policy.ts';
export async function harness(options:Partial<FixtureAppOptions>={}) {
  const db=options.db??openDb(':memory:');
  const runtime=createFixtureApp({...options,db});await runtime.startup(new AbortController().signal);
  const host='127.0.0.1:8787',origin=`http://${host}`;
  let cookie='',csrf='';
  async function request(path:string,body?:unknown,key=randomUUID()) {
    const response=await runtime.app.request(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{host,origin,cookie,...(body===undefined?{}:{'content-type':'application/json','x-csrf-nonce':csrf,'idempotency-key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    return {status:response.status,value:await response.json() as Record<string,any>,headers:response.headers};
  }
  const boot=await request('/api/session');cookie=boot.headers.get('set-cookie')!.split(';')[0]!;csrf=boot.value['csrfNonce'];
  const sign=async()=>request('/api/mandates/test-mandate/sign',{draft:safeDefaults('demo-owner','test-mandate',Date.now()),confirm:true,expectedCurrentHash:null});
  return {db,runtime,request,sign,close:async()=>{await runtime.shutdown();db.close();}};
}
