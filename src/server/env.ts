import { globalAgent } from 'node:https';
export const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
export type RuntimeModes = Readonly<{ paypal: 'fixture' | 'sandbox'; llm: 'fixture' | 'local' | 'hosted'; vault: 'off' }>;
export function readModes(env: Readonly<Record<string, string | undefined>>): RuntimeModes {
  const paypal = env['PAYPAL_MODE'] || 'fixture';
  const llm = env['LLM_MODE'] || 'fixture';
  if (paypal !== 'fixture' && paypal !== 'sandbox') throw new Error('PAYPAL_MODE_INVALID');
  if (llm !== 'fixture' && llm !== 'local' && llm !== 'hosted') throw new Error('LLM_MODE_INVALID');
  if (env['PAYPAL_BASE_URL'] && env['PAYPAL_BASE_URL'] !== SANDBOX_BASE) throw new Error('SANDBOX_BASE_REQUIRED');
  if (paypal === 'sandbox' || llm === 'hosted') requireVerifiedTls(env);
  if (paypal === 'sandbox' && (!env['PAYPAL_CLIENT_ID'] || !env['PAYPAL_CLIENT_SECRET'])) throw new Error('SANDBOX_CONFIGURATION_REQUIRED');
  if (llm === 'local') {
    const url = new URL(env['LLM_LOCAL_URL'] || 'invalid:');
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('LOCAL_MODEL_LOOPBACK_REQUIRED');
  }
  if (llm === 'hosted' && (env['LLM_HOSTED_PROVIDER'] !== 'groq'
    || env['LLM_HOSTED_URL'] !== 'https://api.groq.com/openai/v1/chat/completions'
    || (env['LLM_HOSTED_MODEL'] ?? 'openai/gpt-oss-20b') !== 'openai/gpt-oss-20b'
    || !/^[A-Za-z0-9_-]{8,256}$/.test(env['GROQ_API_KEY'] ?? '')
    || env['LLM_HOSTED_FREE_CONFIRMED'] !== 'yes')) throw new Error('HOSTED_MODEL_CONFIGURATION_REQUIRED');
  return Object.freeze({ paypal, llm, vault: 'off' });
}

/** Check inherited TLS bypasses at startup and again before credential delivery.
 * Hosted HTTPS additionally pins verification and bypasses global dispatchers. */
export function requireVerifiedTls(env: Readonly<Record<string, string | undefined>>): void {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const unsafeOptions = (value: unknown, depth = 0): boolean => {
    if (depth > 16) return true;
    if (!value || typeof value !== 'object') return false;
    for (const key of Reflect.ownKeys(value)) {
      const child = (value as Record<PropertyKey, unknown>)[key];
      const name = typeof key === 'symbol' ? key.description : key;
      if (name === 'rejectUnauthorized' && child === false) return true;
      // Opaque custom connectors/identity checks cannot be certified here.
      if ((name === 'connect' || name === 'checkServerIdentity') && typeof child === 'function') return true;
      if (unsafeOptions(child, depth + 1)) return true;
    }
    return false;
  };
  const dispatcherUnsafe = Reflect.ownKeys(globalThis).some(key => {
    if (typeof key !== 'symbol' || !/^undici\.globalDispatcher\./.test(Symbol.keyFor(key) ?? '')) return false;
    const dispatcher = globals[key];
    if (!dispatcher || typeof dispatcher !== 'object') return dispatcher != null;
    const options = Object.getOwnPropertySymbols(dispatcher).filter(s => s.description === 'options');
    return options.length !== 1 || options.some(s => unsafeOptions((dispatcher as Record<symbol, unknown>)[s]));
  });
  if (env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0' || unsafeOptions(globalAgent.options) || dispatcherUnsafe) {
    throw new Error('TLS_VERIFICATION_REQUIRED: enable certificate verification and remove insecure TLS options before hosted or sandbox use');
  }
}
