import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

test('production inference ignores environment and command-line proxy settings',async()=>{
 let direct=0,proxied=0;
 const model=http.createServer((_req,res)=>{direct++;res.end(JSON.stringify({model:'stub',choices:[]}));});
 const proxy=http.createServer((_req,res)=>{proxied++;res.end('{}');});
 proxy.on('connect',(_req,socket)=>{proxied++;socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');});
 await new Promise<void>(r=>model.listen(0,'127.0.0.1',r));await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));
 try {
  const port=(model.address() as import('node:net').AddressInfo).port;
  const proxyUrl=`http://127.0.0.1:${(proxy.address() as import('node:net').AddressInfo).port}`;
  const code=`import {infer,legacyLocalConfig as localConfig} from './src/server/llm/adapter.ts';const c=localConfig({LLM_LOCAL_URL:'http://127.0.0.1:${port}/v1/chat/completions',LLM_LOCAL_MODEL:'stub'});console.log(JSON.stringify(await infer(c,'agent','test',{},new AbortController().signal,2000)));`;
  const child=spawn(process.execPath,['--use-env-proxy','--input-type=module','-e',code],{env:{...process.env,NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxyUrl,HTTPS_PROXY:proxyUrl,ALL_PROXY:proxyUrl,http_proxy:proxyUrl,https_proxy:proxyUrl,all_proxy:proxyUrl,NO_PROXY:'',no_proxy:''},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const exit=await new Promise(r=>child.on('exit',r));
  assert.equal(exit,0,output);assert.equal(proxied,0,'No model data may reach a proxy');assert.equal(direct,1,'Exactly one direct loopback request');
 }finally{model.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise<void>(r=>model.close(()=>r())),new Promise<void>(r=>proxy.close(()=>r()))]);}
});

for(const status of [204,205,304])test(`direct transport classifies bodyless HTTP ${status} without crashing its process`,async()=>{
 const server=http.createServer((_req,res)=>{res.writeHead(status);res.end();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  const port=(server.address() as import('node:net').AddressInfo).port;
  const code=`import {infer,legacyLocalConfig as localConfig} from './src/server/llm/adapter.ts';const result=await infer(localConfig({LLM_LOCAL_URL:'http://127.0.0.1:${port}/v1/chat/completions',LLM_LOCAL_MODEL:'stub'}),'agent','test',{},new AbortController().signal,2000);console.log(JSON.stringify(result));`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  let output='',errors='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>errors+=d);
  const exit=await new Promise(r=>child.on('exit',r));
  assert.equal(exit,0,errors);const result=JSON.parse(output);
  assert.equal(result.kind,'transport_error');assert.equal(result.attempts,1);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
