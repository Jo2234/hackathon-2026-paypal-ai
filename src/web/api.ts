import type { MutationContext } from './review-policy.ts';
import { ApiError, isRecord, responseEvidence } from './review-policy.ts';
export { ApiError, isBudget, isVerdict } from './review-policy.ts';
export type Envelope = Record<string, unknown> & { mode: { paypal: 'fixture'|'sandbox'; llm: 'fixture'|'local'|'hosted'; provider?: string|null; modelIdentity?: string; model?: string; digest?: string|null; origin?: 'live'|'handwritten'; vault: 'off' }; fixtureLabel: string };
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ApiError('Invalid server response'); return value;
}
export class ConsoleApi {
  private csrf = '';
  private readonly keys = new Map<string, string>();
  async bootstrap(): Promise<Envelope> {
    const result = await this.get('/api/session');
    if (typeof result['csrfNonce'] !== 'string' || !/^[a-f0-9]{64}$/.test(result['csrfNonce'])) throw new ApiError('Session bootstrap refused');
    this.csrf = result['csrfNonce']; return result;
  }
  get(path: string): Promise<Envelope> { return this.request(path); }
  post(path: string, body: unknown, intent: string, context: MutationContext = {}): Promise<Envelope> {
    if (!this.csrf) throw new ApiError('Connect the owner session first');
    if (!this.keys.has(intent)) {
      if (this.keys.size >= 512) throw new ApiError('This console session has reached its command limit. Inspect outstanding outcomes before reconnecting.');
      this.keys.set(intent, crypto.randomUUID());
    }
    return this.request(path, body, this.keys.get(intent)!, context);
  }
  private async request(path: string, body?: unknown, key?: string, context: MutationContext = {}): Promise<Envelope> {
    if (!['http://127.0.0.1:5173', 'http://127.0.0.1:8787'].includes(location.origin) || !/^\/api\/[A-Za-z0-9/?=&%_.-]+$/.test(path)) throw new ApiError('Only the configured local console is supported');
    const mutation = key !== undefined;
    let serialized = '';
    if (mutation) {
      try { const encoded = JSON.stringify(body); if (typeof encoded !== 'string') throw new Error(); serialized = encoded; }
      catch { throw new ApiError('Invalid command input.'); }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), /\/compile$|\/propose$|\/dispatch$|\/reconcile$/.test(path) ? 65_000 : 10_000);
    try {
      const response = await fetch(path, { method: mutation ? 'POST' : 'GET', credentials: 'same-origin', redirect: 'error', signal: controller.signal, ...(mutation ? { headers: { 'content-type': 'application/json', 'x-csrf-nonce': this.csrf, 'idempotency-key': key }, body: serialized } : {}) });
      const reader = response.body?.getReader(); if (!reader) throw new ApiError('Empty server response', response.status, mutation);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.length;
          if (length > 1_048_576) { void reader.cancel().catch(() => undefined); throw new ApiError('Server response exceeded its limit', response.status, mutation); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return responseEvidence(path, response.status, parsed, body, mutation, context) as Envelope;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(mutation ? 'Response unavailable. The command outcome is unknown; inspect the reservation and reconcile. Do not send another payment.' : 'The local service could not be reached.', 0, mutation);
    } finally { clearTimeout(timer); }
  }
}
export function money(minor: number | null | undefined): string {
  return Number.isSafeInteger(minor) ? new Intl.NumberFormat('en-SG', { style: 'currency', currency: 'USD' }).format(minor! / 100) : '—';
}
export function minorInput(value: string): number {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(value)) throw new ApiError('Enter dollars with at most two decimal places');
  const [whole, fraction = ''] = value.split('.'); return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
