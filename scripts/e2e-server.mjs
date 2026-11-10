// One disposable ledger per browser project run; never touches the demo DB.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir=await mkdtemp(join(tmpdir(),'mandate-e2e-'));
const child=spawn(process.execPath,['src/server/main.ts'],{stdio:'inherit',env:{...process.env,PAYPAL_MODE:'fixture',LLM_MODE:'fixture',PORT:new URL(process.env.E2E_BASE_URL??'http://127.0.0.1:5173').port,APP_DB_PATH:join(dir,'fixture.sqlite')}});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',async code=>{await rm(dir,{recursive:true,force:true});process.exitCode=code??1;});
