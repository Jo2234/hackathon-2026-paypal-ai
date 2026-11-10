import { policySchema, proposalSchema } from '../../shared/schemas.ts';
import { safeDefaults } from '../../domain/policy/policy.ts';
import { canonicalJson } from '../../shared/canonical.ts';
const SYNTHETIC_NOW=Date.parse('2030-01-01T00:00:00Z');
const limits=['allowanceMinor','perOrderMaxMinor','perLineMaxMinor','stepUpThresholdMinor','allowedCategories','deniedCategories','deniedSkus','maxQuantityPerLine','maxLinesPerCart','refundRestoration'] as const;
/** Explicit synthetic DTO; never serialize a database row, signed metadata or payment data. */
export function hostedProjection(kind:'compile'|'agent',ownerRequest:string,context:Readonly<Record<string,unknown>>):Record<string,unknown> {
  const p=policySchema.parse(kind==='compile'?context['defaults']:context['policy']);
  const synthetic=safeDefaults('synthetic-owner','synthetic-mandate',SYNTHETIC_NOW);
  for(const field of limits)Object.assign(synthetic,{[field]:p[field]});
  const now=Date.parse(String(context['now']));
  const policy={...synthetic,merchantId:'synthetic-merchant',sourceText:kind==='compile'?ownerRequest:'',compiledBy:kind==='compile'?p.compiledBy:{mode:'manual'},expiresAt:new Date(SYNTHETIC_NOW+Date.parse(p.expiresAt)-now).toISOString()};
  if(kind==='compile')return {defaults:policy,now:new Date(SYNTHETIC_NOW).toISOString(),...policy};
  const b=context['budget'] as Record<string,unknown>|null;
  const budget=b?{allowanceMinor:b['allowanceMinor'],reservedMinor:b['reservedMinor'],capturedMinor:b['capturedMinor'],restoredMinor:b['restoredMinor'],availableMinor:b['availableMinor'],spendBlocked:b['spendBlocked']}:null;
  return {policy,proposalId:'synthetic-proposal',mandateId:'synthetic-mandate',source:context['source'],budget,now:new Date(SYNTHETIC_NOW).toISOString()};
}
export function restoreHosted(kind:'compile'|'agent',output:unknown,context:Readonly<Record<string,unknown>>,projected:Readonly<Record<string,unknown>>):unknown {
  if(kind==='agent') {
    const p=proposalSchema.parse(output);
    if(p.proposalId!==projected['proposalId']||p.mandateId!==projected['mandateId']||canonicalJson(p.source)!==canonicalJson(projected['source']))throw new Error('MODEL_OUTPUT_422');
    return {...p,proposalId:context['proposalId'],mandateId:context['mandateId'],source:context['source']};
  }
  const p=policySchema.parse(output),base=policySchema.parse(context['defaults']),alias=policySchema.parse(projected['defaults']);
  for(const key of ['ownerId','mandateId','version','merchantId','currency','period','compiledBy','sourceText','status','signedAt','contentHash'] as const)if(canonicalJson(p[key])!==canonicalJson(alias[key]))throw new Error('MODEL_OUTPUT_422');
  return {...p,ownerId:base.ownerId,mandateId:base.mandateId,version:base.version,merchantId:base.merchantId,compiledBy:base.compiledBy,expiresAt:new Date(Date.parse(p.expiresAt)+Date.parse(String(context['now']))-SYNTHETIC_NOW).toISOString()};
}
