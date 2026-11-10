import { loadEnvFile } from 'node:process';
import type { SandboxConfig } from './client.ts';
// Only an explicitly selected external file is loaded; no credential discovery.
export function loadSandboxEnv():void {if(process.env['SANDBOX_ENV_FILE'])loadEnvFile(process.env['SANDBOX_ENV_FILE']);}
export function sandboxConfig(env:NodeJS.ProcessEnv):SandboxConfig {
  return {clientId:env['PAYPAL_CLIENT_ID']??'',clientSecret:env['PAYPAL_CLIENT_SECRET']??'',merchantId:env['PAYPAL_MERCHANT_ID']??'',...(env['PAYPAL_BASE_URL']?{baseUrl:env['PAYPAL_BASE_URL']}:{})};
}
