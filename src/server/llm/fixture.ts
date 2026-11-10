import { createHash } from 'node:crypto';
export type FixtureRecord<T> = Readonly<{ fixture:true;origin:'handwritten'|`recorded:${string}`;input:string;output:T }>;
export function fixtureInputKey(input:string):string { return createHash('sha256').update(input.normalize('NFC').trim().replace(/\s+/g,' ')).digest('hex'); }
function deepFreeze<T>(value:T):T {
  if(value && typeof value==='object') { for(const part of Object.values(value)) deepFreeze(part); Object.freeze(value); }
  return value;
}
export function fixtureLookup<T>(records:readonly FixtureRecord<T>[],input:string):Readonly<{mode:'fixture';label:'FIXTURE (handwritten outputs)';output:T}> {
  const key=fixtureInputKey(input),record=records.find(record=>fixtureInputKey(record.input)===key);
  if(!record || record.fixture!==true)throw new Error('FIXTURE_MISS_LLM_UNAVAILABLE');
  return deepFreeze({mode:'fixture' as const,label:'FIXTURE (handwritten outputs)' as const,output:structuredClone(record.output)});
}
