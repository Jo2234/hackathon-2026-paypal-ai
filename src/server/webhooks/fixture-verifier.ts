import { createHmac, timingSafeEqual } from 'node:crypto';
// Explicit non-PayPal protocol for offline injected fixtures. Not an RSA/cert verifier.
export class FixtureWebhookVerifier {
  readonly mode='fixture-hmac-v1' as const;
  private readonly key:Buffer;
  private readonly webhookId:string;
  constructor(key:Uint8Array,webhookId:string) {
    if(key.length!==32 || !/^[A-Za-z0-9-]{1,128}$/.test(webhookId)) throw new Error('FIXTURE_VERIFIER_CONFIG');
    this.key=Buffer.from(key);this.webhookId=webhookId;
  }
  verify(body:Uint8Array,headers:Headers):boolean {
    const id=headers.get('x-fixture-transmission-id')??'',stamp=headers.get('x-fixture-transmission-time')??'',sig=headers.get('x-fixture-signature')??'';
    if(body.length>262144 || !/^[A-Za-z0-9-]{1,128}$/.test(id) || !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(stamp) || !/^[a-f0-9]{64}$/.test(sig)) return false;
    const expected=createHmac('sha256',this.key).update(`${id}|${stamp}|${this.webhookId}|`).update(body).digest();
    return timingSafeEqual(expected,Buffer.from(sig,'hex'));
  }
}
