import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const diff=execFileSync('git',['diff','HEAD','--'],{encoding:'utf8',maxBuffer:8*1024*1024});
const files=execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const text=diff+files.map(p=>readFileSync(p,'utf8')).join('\n');
const patterns=[/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,/AKIA[0-9A-Z]{16}/,/(?:access_token|client_secret|PAYPAL_CLIENT_SECRET|PAYPAL_CLIENT_ID)\s*[=:]\s*["'][A-Za-z0-9_~-]{24,}/];
if(patterns.some(p=>p.test(text)))throw new Error('SECRET_SCAN_FAILED');
console.log('PASS: diff and nonignored untracked files scanned for credential assignments and private keys; no values printed');
