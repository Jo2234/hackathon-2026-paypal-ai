import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
// Poison the catalogue module actually imported by narrow.ts. No production DI
// accepts merchant text, display names, or attacker-supplied catalogue facts.
const products=JSON.parse(readFileSync(new URL('../../catalogue/products.json',import.meta.url),'utf8'));
const map=JSON.parse(readFileSync(new URL('../../catalogue/category-map.json',import.meta.url),'utf8'));
registerHooks({load(url,ctx,next){
 if(url.endsWith('/src/domain/engine/catalogue.ts'))return {format:'module',shortCircuit:true,source:`export const catalogue=${JSON.stringify(products)};export const categoryMap=${JSON.stringify(map)};`};
 return next(url,ctx);
}});
const {buildNarrowRequest}=await import('../../src/server/llm/narrow.ts');
const {catalogue}=await import('../../src/domain/engine/catalogue.ts');
test('whole 45-row corpus withheld: byte-identical bodies even with poisoned catalogue names/descriptions',()=>{
 const corpus=readFileSync(new URL('../../fixtures/adversarial/descriptions.jsonl',import.meta.url),'utf8').trim().split('\n').map(s=>JSON.parse(s));assert.equal(corpus.length,45);
 const extractionBaseline=JSON.stringify(buildNarrowRequest('extraction','Allow $60 weekly, $40 per order, $10 per line, ask above $20.'));
 const baseline=JSON.stringify(buildNarrowRequest('selection','Buy exactly 1 Ground coffee.'));
 for(const row of corpus){
  for(const product of catalogue){Object.assign(product,{description:row.description,name:row.description,imageAlt:row.description,merchantText:row.description});}
  const body=JSON.stringify(buildNarrowRequest('selection','Buy exactly 1 Ground coffee.'));
  assert.equal(body,baseline,row.id);
  assert.equal(JSON.stringify(buildNarrowRequest('extraction','Allow $60 weekly, $40 per order, $10 per line, ask above $20.')),extractionBaseline,row.id);
  assert.ok(!body.includes(JSON.stringify(row.description).slice(1,-1)),row.id);
 }
});
