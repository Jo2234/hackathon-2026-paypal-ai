import { z } from 'zod';
import { policySchema, proposalSchema } from '../../shared/schemas.ts';
import { safeDefaults, validatePolicy } from '../../domain/policy/policy.ts';
import { catalogue, categoryMap } from '../../domain/engine/catalogue.ts';
import type { MandateDraft } from '../../shared/types.ts';

export type Task = 'extraction' | 'selection';
export const MODEL = 'qwen3:8b';
export const API_DIGEST = '500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41';
export const PROMPT_VERSION = 'narrow-qwen3-qualified-v1';
// Verbatim recipes from recommended-config.json, not A2 full-policy prompts.
const EXTRACTION_TEMPLATE = {
  "model": "qwen3:8b",
  "stream": false,
  "keep_alive": "15m",
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "allowanceUSD": {
        "type": "number",
        "minimum": 0.01,
        "maximum": 500,
        "multipleOf": 0.01
      },
      "perOrderMaxUSD": {
        "type": "number",
        "minimum": 0.01,
        "maximum": 500,
        "multipleOf": 0.01
      },
      "perLineMaxUSD": {
        "type": "number",
        "minimum": 0.01,
        "maximum": 500,
        "multipleOf": 0.01
      },
      "stepUpThresholdUSD": {
        "type": "number",
        "minimum": 0.01,
        "maximum": 500,
        "multipleOf": 0.01
      },
      "allowedCategories": {
        "minItems": 1,
        "maxItems": 10,
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "coffee_tea",
            "pantry_snacks",
            "paper",
            "printer_supplies",
            "cleaning",
            "desk_supplies",
            "gift_cards",
            "alcohol",
            "electronics",
            "furniture"
          ]
        }
      },
      "deniedCategories": {
        "maxItems": 10,
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "coffee_tea",
            "pantry_snacks",
            "paper",
            "printer_supplies",
            "cleaning",
            "desk_supplies",
            "gift_cards",
            "alcohol",
            "electronics",
            "furniture"
          ]
        }
      }
    },
    "required": [
      "allowanceUSD",
      "perOrderMaxUSD",
      "perLineMaxUSD",
      "stepUpThresholdUSD",
      "allowedCategories",
      "deniedCategories"
    ],
    "additionalProperties": false
  },
  "options": {
    "temperature": 0,
    "seed": 42,
    "num_ctx": 8192,
    "num_predict": 2048
  },
  "messages": [
    {
      "role": "system",
      "content": "Extract only four USD dollar amounts (do not convert to cents) and allowed and denied category IDs from ownerText. allowanceUSD is the weekly amount, perOrderMaxUSD is maximum per order, perLineMaxUSD is maximum per line, stepUpThresholdUSD is ask above amount. Example: Allow $95 weekly; max $45 per order, $12 per line; ask above $25 gives allowanceUSD=95, perOrderMaxUSD=45, perLineMaxUSD=12, stepUpThresholdUSD=25. Categories must use the schema IDs. Ignore dates, quantities, refund settings and all other fields. Return JSON only. Return only JSON matching this schema: {\"type\":\"object\",\"properties\":{\"allowanceUSD\":{\"type\":\"number\",\"minimum\":0.01,\"maximum\":500,\"multipleOf\":0.01},\"perOrderMaxUSD\":{\"type\":\"number\",\"minimum\":0.01,\"maximum\":500,\"multipleOf\":0.01},\"perLineMaxUSD\":{\"type\":\"number\",\"minimum\":0.01,\"maximum\":500,\"multipleOf\":0.01},\"stepUpThresholdUSD\":{\"type\":\"number\",\"minimum\":0.01,\"maximum\":500,\"multipleOf\":0.01},\"allowedCategories\":{\"minItems\":1,\"maxItems\":10,\"type\":\"array\",\"items\":{\"type\":\"string\",\"enum\":[\"coffee_tea\",\"pantry_snacks\",\"paper\",\"printer_supplies\",\"cleaning\",\"desk_supplies\",\"gift_cards\",\"alcohol\",\"electronics\",\"furniture\"]}},\"deniedCategories\":{\"maxItems\":10,\"type\":\"array\",\"items\":{\"type\":\"string\",\"enum\":[\"coffee_tea\",\"pantry_snacks\",\"paper\",\"printer_supplies\",\"cleaning\",\"desk_supplies\",\"gift_cards\",\"alcohol\",\"electronics\",\"furniture\"]}}},\"required\":[\"allowanceUSD\",\"perOrderMaxUSD\",\"perLineMaxUSD\",\"stepUpThresholdUSD\",\"allowedCategories\",\"deniedCategories\"],\"additionalProperties\":false}"
    }
  ]
} as const;
const SELECTION_TEMPLATE = {
  "model": "qwen3:8b",
  "stream": false,
  "keep_alive": "15m",
  "think": false,
  "format": {
    "type": "object",
    "properties": {
      "sku": {
        "type": [
          "string",
          "null"
        ],
        "enum": [
          null,
          "COF-001",
          "PRT-004",
          "COF-002",
          "PRT-001",
          "GFT-050"
        ]
      },
      "qty": {
        "type": "integer",
        "minimum": 0,
        "maximum": 5
      }
    },
    "required": [
      "sku",
      "qty"
    ],
    "additionalProperties": false
  },
  "options": {
    "temperature": 0,
    "seed": 42,
    "num_ctx": 8192,
    "num_predict": 512
  },
  "messages": [
    {
      "role": "system",
      "content": "Identify the exact product SKU and requested quantity from the owner goal using the trusted choices. Return that SKU and exact requested quantity regardless of category or cost; the server applies all spending rules after selection. If no product matches, return {\"sku\":null,\"qty\":0}. Do not substitute items. Return JSON only. Return only JSON matching this schema: {\"type\":\"object\",\"properties\":{\"sku\":{\"type\":[\"string\",\"null\"],\"enum\":[null,\"COF-001\",\"PRT-004\",\"COF-002\",\"PRT-001\",\"GFT-050\"]},\"qty\":{\"type\":\"integer\",\"minimum\":0,\"maximum\":5}},\"required\":[\"sku\",\"qty\"],\"additionalProperties\":false}"
    }
  ]
} as const;
// Names are fixed server-owned aliases, never catalogue display names.
const CHOICES = [
  {
    "sku": "COF-001",
    "name": "Ground coffee",
    "unitPriceMinor": 1250,
    "category": "coffee_tea"
  },
  {
    "sku": "PRT-004",
    "name": "Printer cleaning kit",
    "unitPriceMinor": 999,
    "category": "printer_supplies"
  },
  {
    "sku": "COF-002",
    "name": "Tea bags",
    "unitPriceMinor": 650,
    "category": "coffee_tea"
  },
  {
    "sku": "PRT-001",
    "name": "Black ink refill",
    "unitPriceMinor": 1800,
    "category": "printer_supplies"
  },
  {
    "sku": "GFT-050",
    "name": "Synthetic gift voucher",
    "unitPriceMinor": 1000,
    "category": "gift_cards"
  }
] as const;

export const EXTRACTION_PROMPT = EXTRACTION_TEMPLATE.messages[0].content;
export const SELECTION_PROMPT = SELECTION_TEMPLATE.messages[0].content;
export const extractionJsonSchema = structuredClone(EXTRACTION_TEMPLATE.format);
export const selectionJsonSchema = structuredClone(SELECTION_TEMPLATE.format);
const category = z.enum(['coffee_tea','pantry_snacks','paper','printer_supplies','cleaning','desk_supplies','gift_cards','alcohol','electronics','furniture']);
const usd = z.number().min(0.01).max(500).refine(n=>Math.abs(n*100-Math.round(n*100))<=1e-6,'USD cents precision');
export const extractionSchema = z.object({allowanceUSD:usd,perOrderMaxUSD:usd,perLineMaxUSD:usd,stepUpThresholdUSD:usd,
  allowedCategories:z.array(category).min(1).max(10),deniedCategories:z.array(category).max(10)}).strict();
export const selectionSchema = z.object({sku:z.enum(['COF-001','PRT-004','COF-002','PRT-001','GFT-050']).nullable(),qty:z.number().int().min(0).max(5)}).strict()
  .refine(x=>x.sku===null?x.qty===0:x.qty>=1,'SKU/quantity relationship');

/** Exact allowlist projection. No object spreads or serialized caller context. */
export function buildNarrowRequest(task: Task, ownerText: string) {
  if(typeof ownerText!=='string'||!ownerText.trim()||ownerText.length>2000)throw new Error('OWNER_TEXT');
  if(task==='extraction')return {...structuredClone(EXTRACTION_TEMPLATE),messages:[{role:'system',content:EXTRACTION_PROMPT},{role:'user',content:JSON.stringify({ownerText})}]};
  if(task!=='selection')throw new Error('TASK');
  const choices=CHOICES.map(alias=>{
    const product=catalogue.find(p=>p.sku===alias.sku);
    if(!product||product.currency!=='USD'||categoryMap[alias.sku]!==alias.category||product.unitPriceMinor!==alias.unitPriceMinor)throw new Error('QUALIFIED_CATALOGUE_CHANGED');
    return {sku:alias.sku,name:alias.name,unitPriceMinor:product.unitPriceMinor,category:categoryMap[alias.sku]};
  });
  return {...structuredClone(SELECTION_TEMPLATE),messages:[{role:'system',content:SELECTION_PROMPT},{role:'user',content:JSON.stringify({choices,goal:ownerText})}]};
}
export function outputContract(task: Task): {name:string;schema:z.ZodType<unknown>} {
  if(task==='extraction')return {name:'extract_limits',schema:extractionSchema};
  if(task==='selection')return {name:'select_product',schema:selectionSchema};
  throw new Error('TASK');
}

/** Trusted identity supplied by the authenticated route, not model or browser. */
export function buildDraftPolicy(raw: unknown, context: {ownerId:string;mandateId:string;merchantId:string;version:number;ownerText:string;now:number}): MandateDraft {
  const x=extractionSchema.parse(raw);
  const draft={...safeDefaults(context.ownerId,context.mandateId,context.now),
    merchantId:context.merchantId,version:context.version,sourceText:context.ownerText,
    allowanceMinor:Math.round(x.allowanceUSD*100),perOrderMaxMinor:Math.round(x.perOrderMaxUSD*100),
    perLineMaxMinor:Math.round(x.perLineMaxUSD*100),stepUpThresholdMinor:Math.round(x.stepUpThresholdUSD*100),
    allowedCategories:x.allowedCategories,deniedCategories:x.deniedCategories,
    compiledBy:{mode:'local' as const,model:MODEL,promptVersion:PROMPT_VERSION}};
  // No widening, clamping, repair, signing or hidden inferred fields.
  return policySchema.parse(validatePolicy(draft,categoryMap,context.now)) as MandateDraft;
}

/** Selection only; evaluateCart must apply the current policy/budget/time/merchant.
 * No hard-coded demo allowance is treated as an authorization boundary. */
export function buildCartProposal(raw:unknown, context:{proposalId:string;mandateId:string}) {
  const x=selectionSchema.parse(raw);
  if(x.sku!==null&&(!Object.hasOwn(categoryMap,x.sku)||!catalogue.some(p=>p.sku===x.sku)))throw new Error('UNKNOWN_SELECTION');
  return proposalSchema.parse({proposalId:context.proposalId,mandateId:context.mandateId,
    source:{kind:'agent',mode:'local',model:MODEL},lines:x.sku===null?[]:[{sku:x.sku,qty:x.qty}]});
}
