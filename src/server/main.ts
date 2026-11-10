import { loadSandboxEnv, sandboxConfig } from './paypal/config.ts';
import { localConfig, hostedConfig } from './llm/adapter.ts';
import { readModes } from './env.ts';
import { SandboxPayPal } from './paypal/client.ts';
import { pathToFileURL } from 'node:url';
import { mkdirSync, appendFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { openDb } from './db/db.ts';
import { createFixtureApp } from './app.ts';
import { FIXTURE_LABEL } from './paypal/provider.ts';
import { LIMITS } from '../shared/limits.ts';
import { systemClock } from '../shared/clock.ts';

// Imports never listen. pnpm start serves the built console and API together.
export async function main():Promise<void> {
  loadSandboxEnv();
  const modes=readModes(process.env);
  const llm=modes.llm==='local'?localConfig(process.env):modes.llm==='hosted'?hostedConfig(process.env):undefined;
  const evidencePath=new URL('../../../evidence/sandbox/transport.jsonl',import.meta.url).pathname;
  if(modes.paypal==='sandbox')mkdirSync(dirname(evidencePath),{recursive:true});
  const provider=modes.paypal==='sandbox'?new SandboxPayPal(sandboxConfig(process.env),fetch,event=>{
    // Allowlisted metadata only, including HTTP failures. Never bodies/headers/tokens.
    appendFileSync(evidencePath,JSON.stringify(event)+'\n',{mode:0o600});
  }):undefined;
  const dbPath=process.env['APP_DB_PATH']??new URL(`../../data/${modes.paypal}.sqlite`,import.meta.url).pathname;
  const port=Number(process.env['PORT']??5173);
  if(![5173,8787].includes(port))throw new Error('PORT_UNSUPPORTED');
  if(!existsSync('dist/index.html'))throw new Error('BUILD_REQUIRED');
  mkdirSync(dirname(dbPath),{recursive:true});
  // Vite's /api proxy preserves the browser authority. This ONE configured
  // console authority is independent of the internal loopback listener address.
  const db=openDb(dbPath),lifetime=new AbortController(),runtime=createFixtureApp({db,host:`127.0.0.1:${port}`,...(llm?{llm}:{}),...(provider?{provider}:{})});
  let server:Server|undefined,stopping=false,shutdownPromise:Promise<boolean>|undefined;
  const shutdown=():Promise<boolean>=>{
    if(shutdownPromise)return shutdownPromise;
    stopping=true;
    // Freeze once. Request drain and listener close consume this same five seconds.
    const endsAt=systemClock.monotonicNow()+LIMITS.shutdownMs;
    const drain=runtime.shutdown(endsAt);lifetime.abort();
    const listener=server;
    const closed=!listener?Promise.resolve(true):new Promise<boolean>(resolve=>{
      let settled=false;
      const finish=(known:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);resolve(known);};
      const timer=setTimeout(()=>{try {listener.closeAllConnections();}catch { /* unknown, fixed result only */ }finally {finish(false);}},Math.max(0,endsAt-systemClock.monotonicNow()));
      try {listener.close(error=>finish(!error));}catch {finish(false);}
    });
    shutdownPromise=Promise.all([drain,closed]).then(([result,listenerClosed])=>{
      if(result.state!=='drained' || !listenerClosed || runtime.failures.unknown) {
        runtime.failures.fail('SHUTDOWN_UNKNOWN_503');process.exitCode=1;return false;
      }
      // No admitted action remains that can later resume against a closed DB.
      try {db.close();return true;}catch(error){runtime.failures.observe(error);process.exitCode=1;return false;}
    },error=>{runtime.failures.observe(error);runtime.failures.fail('SHUTDOWN_UNKNOWN_503');process.exitCode=1;return false;});
    return shutdownPromise;
  };
  const onSignal=()=>{void shutdown().then(known=>{if(!known)console.error('FIXTURE_SHUTDOWN_UNKNOWN');},()=>{process.exitCode=1;console.error('FIXTURE_SHUTDOWN_UNKNOWN');});};
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try {
    await runtime.startup(lifetime.signal);
    if(stopping)return;
    const app=new Hono();
    app.all('/api/*',c=>runtime.app.fetch(c.req.raw));
    app.use('/assets/*',serveStatic({root:'./dist'}));
    app.get('*',serveStatic({path:'./dist/index.html'}));
    server=serve({fetch:app.fetch,hostname:'127.0.0.1',port,serverOptions:{maxHeaderSize:LIMITS.headersBytes}}) as Server;
    server.maxHeadersCount=100;server.requestTimeout=LIMITS.post.sessionMs;
    server.headersTimeout=LIMITS.mutationMs;server.keepAliveTimeout=LIMITS.shutdownMs;
    console.info(`${provider?.label??(modes.llm==='fixture'?FIXTURE_LABEL:'SIMULATED PAYPAL APPROVAL — FIXTURE (no PayPal calls)')} | Model: ${modes.llm==='fixture'?'handwritten fixture (no model calls)':llm?.model} | http://127.0.0.1:${port}`);
  } catch(error) {await shutdown();throw error;}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {await main();}catch(error) {
    const code=error instanceof Error?error.message:'START_FAILED';
    const help=code==='PORT_UNSUPPORTED'?'Set PORT to 5173 (default) or 8787; only these loopback session authorities are supported.':code==='BUILD_REQUIRED'?'Run pnpm build before pnpm start.':code==='SANDBOX_BASE_REQUIRED'?'SANDBOX_BASE_REQUIRED: Remove the override or use exactly https://api-m.sandbox.paypal.com; changing credentials cannot fix the endpoint.':code.includes('SANDBOX')?'Set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_MERCHANT_ID privately for sandbox, or use PAYPAL_MODE=fixture.':code.includes('MODEL')||code.includes('LLM')?'Set local LLM_LOCAL_URL and LLM_LOCAL_MODEL, or hosted LLM_HOSTED_PROVIDER, LLM_HOSTED_URL, GROQ_API_KEY and LLM_HOSTED_FREE_CONFIRMED (optional LLM_HOSTED_MODEL); see README for the required Free account inspection.':'Check the selected modes, PORT and writable APP_DB_PATH; see README.';
    console.error(`Cannot start SpendingMandates. ${help}`);process.exitCode=1;
  }
}
