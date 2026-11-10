import { defineConfig } from '@playwright/test';
const sandbox=process.argv.some(arg=>arg.includes('sandbox-human'));
export default defineConfig({
  testDir:'./tests/e2e',workers:1,fullyParallel:false,retries:0,
  timeout:45_000,expect:{timeout:15_000},reporter:'list',
  outputDir:`../evidence/e2e/artifacts/${sandbox?'sandbox':process.env['E2E_PROJECT']??'fixture'}`,
  use:{baseURL:process.env['E2E_BASE_URL']??'http://127.0.0.1:5173',browserName:'chromium',storageState:{cookies:[],origins:[]}},
  // Each project has a fresh browser AND a distinct owner in a fresh server DB.
  // The second project's clean-owner assertion requires a separate server run.
  projects:[
    {name:'fixture-desktop',testMatch:'fixture-owner.spec.ts',use:{viewport:{width:1280,height:900},trace:'on',screenshot:'on'}},
    {name:'fixture-phone',testMatch:'fixture-owner.spec.ts',use:{viewport:{width:390,height:844},trace:'on',screenshot:'on'}},
    {name:'sandbox-human',testMatch:'sandbox-human.spec.ts',use:{headless:false,trace:'off',screenshot:'off'}},
  ],
  ...(!sandbox?{webServer:{command:'pnpm build && node scripts/e2e-server.mjs',url:process.env['E2E_BASE_URL']??'http://127.0.0.1:5173',reuseExistingServer:false,timeout:120_000}}:{}),
});
