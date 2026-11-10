import { spawnSync } from 'node:child_process';
for(const project of ['fixture-desktop','fixture-phone']) {
  const result=spawnSync('pnpm',['exec','playwright','test',`--project=${project}`],{stdio:'inherit',env:{...process.env,E2E_PROJECT:project}});
  if(result.status!==0){process.exitCode=result.status??1;break;}
}
