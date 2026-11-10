import { describe,it,expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { catalogue,categoryMap,enforcementCatalogue } from '../../src/domain/engine/catalogue.ts';
import { evaluateCart } from '../../src/domain/engine/engine.ts';
import { oracleAllows } from '../../src/domain/engine/reference-oracle.ts';
import { policyHash,safeDefaults,signReviewedDraft } from '../../src/domain/policy/policy.ts';
import type { BudgetSnapshot,CartProposal,OwnerReview } from '../../src/shared/types.ts';
const now=Date.parse('2026-10-19T01:00:00Z');
const review:OwnerReview={confirm:true,expectedCurrentHash:null,explicitlyAllowedSensitive:[]};
const policy=signReviewedDraft(safeDefaults('o','m',now),review,categoryMap,now,null,1);
const budget:BudgetSnapshot={ownerId:'o',periodKey:'2026-W43@Asia/Singapore',allowanceMinor:8000,reservedMinor:0,capturedMinor:0,refundedCompletedMinor:0,restoredMinor:0,externalRefundedMinor:0,availableMinor:8000,spendBlocked:false,spendBlockReasons:[]};
const cart:CartProposal={proposalId:'a2',mandateId:'m',lines:[{sku:'COF-001',qty:2},{sku:'PRT-004',qty:1}],source:{kind:'owner'}};
describe('F7/F11/F20 policy and description-free engine DRAFT',()=>{
  it('A2 totals 3999 and requires confirmation; A3 gift card is denied',()=>{
    expect(catalogue).toHaveLength(30);expect(Object.keys(categoryMap)).toHaveLength(30);
    const verdict=evaluateCart(policy,enforcementCatalogue,categoryMap,cart,budget,now, false, 'demo-merchant');
    expect(verdict.orderTotalMinor).toBe(3999);expect(verdict.ruleIds).toEqual(['R12_STEP_UP_REQUIRED']);
    expect(evaluateCart(policy,enforcementCatalogue,categoryMap,cart,budget,now,true, 'demo-merchant').ok).toBe(true);
    expect(evaluateCart(policy,enforcementCatalogue,categoryMap,{...cart,lines:[{sku:'GFT-050',qty:10}]},budget,now,true, 'demo-merchant').ruleIds).toContain('R05_CATEGORY_DENIED');
  });
  it('requires strict proposal, owner sensitive tick and disjoint categories',()=>{
    expect(evaluateCart(policy,enforcementCatalogue,categoryMap,{...cart,price:1},budget,now,true, 'demo-merchant').ruleIds).toEqual(['R16_SCHEMA']);
    expect(()=>signReviewedDraft({...safeDefaults('o','m',now),allowedCategories:['gift_cards'],deniedCategories:[]},review,categoryMap,now,null,1)).toThrow('SENSITIVE');
    expect(()=>signReviewedDraft({...safeDefaults('o','m',now),perLineMaxMinor:9000},review,categoryMap,now,null,1)).toThrow();
    expect(policyHash({...policy,sourceText:'different description',status:'REVOKED'})).toBe(policy.contentHash);
    expect(evaluateCart(policy,enforcementCatalogue,categoryMap,cart,budget,Date.parse(policy.expiresAt),true, 'demo-merchant').ruleIds).toContain('R02_MANDATE_EXPIRED');
  });
  it('all corpus and generated descriptions leave enforcement projection identical',()=>{
    const corpus=readFileSync(new URL('../../fixtures/adversarial/descriptions.jsonl',import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line) as {description:string});
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    const baseline=evaluateCart(policy,enforcementCatalogue,categoryMap,cart,budget,now,true, 'demo-merchant');
    const assertDescription=(description:string)=>{
      const changed=catalogue.map(item=>({...item,description}));
      const projected=Object.fromEntries(changed.map(item=>[item.sku,{unitPriceMinor:item.unitPriceMinor,currency:item.currency}]));
      expect(evaluateCart(policy,projected,categoryMap,cart,budget,now,true, 'demo-merchant')).toEqual(baseline);
    };
    corpus.forEach(item=>assertDescription(item.description));fc.assert(fc.property(fc.string(),assertDescription),{numRuns:1000,seed:190027});
  });
  it('independent oracle agrees on generated raw proposals',()=>{
    fc.assert(fc.property(fc.array(fc.record({sku:fc.constantFrom(...Object.keys(categoryMap),'UNKNOWN'),qty:fc.oneof(fc.integer({min:-2,max:25}),fc.double({noNaN:true}))}),{maxLength:12}),fc.boolean(),(lines,extra)=>{
      const raw={...cart,lines,...(extra?{note:'untrusted'}:{})};
      expect(evaluateCart(policy,enforcementCatalogue,categoryMap,raw,budget,now,true, 'demo-merchant').ok).toBe(oracleAllows(policy,enforcementCatalogue,categoryMap,raw,budget,now,true));
    }),{numRuns:1000,seed:190028});
  });
  describe('sensitivity',()=>{it('same oracle assertion detects removed R06 enforcement',()=>{
    const cartOutside={...cart,lines:[{sku:'PAP-001',qty:1}]};
    expect(oracleAllows(policy,enforcementCatalogue,categoryMap,cartOutside,budget,now,true)).toBe(false);
    const mutantPolicy={...policy,allowedCategories:[...policy.allowedCategories,'paper' as const]};
    expect(()=>expect(evaluateCart(mutantPolicy,enforcementCatalogue,categoryMap,cartOutside,budget,now,true, 'demo-merchant').ok).toBe(oracleAllows(policy,enforcementCatalogue,categoryMap,cartOutside,budget,now,true))).toThrow();
  });});
});
