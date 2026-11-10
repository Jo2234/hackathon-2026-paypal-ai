import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const repo=fileURLToPath(new URL('../../',import.meta.url));
function exported(run) {
 const root=mkdtempSync(join(tmpdir(),'mandate-config-')),dir=join(root,'candidate');mkdirSync(dir);
 for(const path of ['src','scripts','catalogue','fixtures','package.json','playwright.config.ts'])cpSync(join(repo,path),join(dir,path),{recursive:true});
 symlinkSync(join(repo,'node_modules'),join(dir,'node_modules'),'dir');
 // This is a synthetic sibling, never the workspace's private directory.
 mkdirSync(join(root,'.secrets'));writeFileSync(join(root,'.secrets','sandbox.env'),'PAYPAL_CLIENT_ID=synthetic-id\nPAYPAL_CLIENT_SECRET=offline\nPAYPAL_MERCHANT_ID=SYNTHETICSELLER\n');
 const guard=join(root,'guard.mjs');writeFileSync(guard,`import {appendFileSync} from 'node:fs';import http from 'node:http';import https from 'node:https';import net from 'node:net';const deny=()=>{appendFileSync(${JSON.stringify(join(root,'network'))},'attempt\\n');throw Error('NETWORK_FORBIDDEN')};globalThis.fetch=deny;http.request=deny;https.request=deny;net.Socket.prototype.connect=deny;`);
 const env={PATH:process.env.PATH,HOME:root,PAYPAL_MODE:'sandbox',LLM_MODE:'fixture',SANDBOX_ENV_FILE:''};
 const child=(script,extra={})=>spawnSync(process.execPath,['--import',guard,script],{cwd:dir,env:{...env,...extra},encoding:'utf8',timeout:10000});
 try{run({root,dir,child});assert.equal(readdirSync(root).includes('network'),false,'zero network attempts');}finally{rmSync(root,{recursive:true,force:true});}
}
test('invalid sandbox base reports safe endpoint guidance without echo or network',()=>exported(({child})=>{
 const r=child('src/server/main.ts',{PAYPAL_CLIENT_ID:'synthetic-id',PAYPAL_CLIENT_SECRET:'offline',PAYPAL_MERCHANT_ID:'SYNTHETICSELLER',PAYPAL_BASE_URL:'https://invalid.example/PRIVATE_SENTINEL'});
 assert.equal(r.status,1);assert.match(r.stderr,/SANDBOX_BASE_REQUIRED/);assert.match(r.stderr,/Remove the override or use exactly https:\/\/api-m\.sandbox\.paypal\.com/);assert.match(r.stderr,/changing credentials cannot fix/i);assert.doesNotMatch(r.stderr,/PRIVATE_SENTINEL|offline|synthetic-id|SYNTHETICSELLER/);
}));
test('sandbox script ignores synthetic sibling secrets without explicit configuration',()=>exported(({root,child})=>{
 const r=child('scripts/test-sandbox.mjs');assert.equal(r.status,2);assert.match(r.stdout,/SANDBOX_ENV_FILE.*explicit/i);
 const report=JSON.parse(readFileSync(join(root,'evidence/sandbox',readdirSync(join(root,'evidence/sandbox'))[0]),'utf8'));
 assert.match(report.reason,/SANDBOX_ENV_FILE.*explicit/i);assert.equal(report.failure,undefined);assert.deepEqual(report.calls,[]);
}));
for(const mode of ['file','environment'])test(`sandbox explicit ${mode} reaches consent guard without transport`,()=>exported(({root,child})=>{
 const r=child('scripts/test-sandbox.mjs',mode==='file'?{SANDBOX_ENV_FILE:join(root,'.secrets/sandbox.env')}:{PAYPAL_CLIENT_ID:'synthetic-id',PAYPAL_CLIENT_SECRET:'offline',PAYPAL_MERCHANT_ID:'SYNTHETICSELLER'});
 assert.equal(r.status,1);const report=JSON.parse(readFileSync(join(root,'evidence/sandbox',readdirSync(join(root,'evidence/sandbox'))[0]),'utf8'));
 assert.equal(report.failure.error.code,'INTERACTIVE_BUYER_CONSENT_REQUIRED');assert.deepEqual(report.calls,[]);
}));
test('Playwright leaves normal cache selection to Playwright and respects explicit override',()=>exported(({dir})=>{
 for(const override of [undefined,'/explicit/browser-cache']) {
 const r=spawnSync(process.execPath,['--input-type=module','-e',"await import('./playwright.config.ts');console.log(JSON.stringify(process.env.PLAYWRIGHT_BROWSERS_PATH??null))"],{cwd:dir,env:{PATH:process.env.PATH,HOME:dir,...(override?{PLAYWRIGHT_BROWSERS_PATH:override}:{})},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout.trim()),override??null);
 }
}));
test('Git tracks the public env template while ignoring credentials and explicit browser cache',()=>{
 const dir=mkdtempSync(join(tmpdir(),'mandate-ignore-'));
 try {
 cpSync(join(repo,'.gitignore'),join(dir,'.gitignore'));
 assert.equal(spawnSync('git',['init','--quiet'],{cwd:dir}).status,0);
 const ignored=path=>spawnSync('git',['check-ignore','--no-index',path],{cwd:dir}).status;
 assert.equal(ignored('.env.example'),1);
 for(const path of ['.env','nested/.env.private','private.env','.cache/ms-playwright/browser'])assert.equal(ignored(path),0,path);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
