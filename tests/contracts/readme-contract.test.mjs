import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const readme=readFileSync(new URL('../../README.md',import.meta.url),'utf8');
test('V06: private environment creation has an executable umask/chmod recipe',()=>assert.match(readme,/umask 077|chmod 600/));
test('V18: troubleshooting names the model-unavailable error actually returned by routes',()=>assert.match(readme,/`MODEL_UNAVAILABLE_503`/));
test('cold judge browser: install instructions include Chromium installation',()=>assert.match(readme,/pnpm exec playwright install chromium/));
