import { z } from 'zod'
import { ApiError, request } from './request'

export const subscriptionProviders = [
  'codex',
  'claude',
  'antigravity',
  'xai',
] as const
export type SubscriptionProvider = (typeof subscriptionProviders)[number]
export const providers = [
  'codex',
  'claude',
  'antigravity',
  'xai',
  'openai',
] as const
export type Provider = (typeof providers)[number]
export const providerLabels: Record<Provider, string> = {
  openai: 'OpenAI API',
  xai: 'Grok',
  codex: 'Codex',
  claude: 'Claude',
  antigravity: 'Antigravity (Gemini)',
}
export const callbackURLs: Partial<Record<Provider, string>> = {
  codex: 'http://localhost:1455/auth/callback',
  claude: 'http://localhost:54545/callback',
  antigravity: 'http://localhost:51121/oauth-callback',
}

export const accountSchema = z.object({
  id: z.string().min(1),
  proxy_id: z.string().default(''),
  provider: z.enum(subscriptionProviders).default('codex'),
  // Saved limits survive upgrades; keep this range aligned with runtime responses.
  max_concurrency: z.number().int().min(1).max(1000).default(30),
  name: z.string(),
  group_count: z.number().int().nonnegative().optional(),
  email: z.string(),
  plan: z.string(),
  enabled: z.boolean(),
  status: z.enum(['ready', 'unverified', 'reauth_required']),
  expires_at: z.number().int().nonnegative(),
  created_at: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
})
export type Account = z.infer<typeof accountSchema>
const pageSchema = z.object({ accounts: z.array(accountSchema).max(100) })
const authorizationSchema = z.object({
  url: z.url().refine((value) => {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      [
        'auth.openai.com',
        'claude.ai',
        'accounts.google.com',
        'auth.x.ai',
        'accounts.x.ai',
        'x.ai',
        'grok.com',
      ].includes(url.hostname) &&
      !url.username &&
      !url.password
    )
  }),
  user_code: z.string().min(1).max(128).optional(),
  interval: z.number().int().min(5).max(60).optional(),
  state: z.string().min(1),
  callback_url: z.url().optional(),
  expires_at: z.number().int().positive(),
})
const modelsSchema = z
  .array(
    z.object({
      id: z.string(),
      object: z.literal('model'),
      owned_by: z.string(),
    }),
  )
  .max(512)
export const accountOptions = {
  queryKey: ['accounts'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    request('/api/accounts', pageSchema, { signal }),
}
export function importAccount(input: {
  provider?: SubscriptionProvider
  name: string
  auth_json: string
  replace_id?: string
  proxy_id?: string
}) {
  return request('/api/accounts/import', accountSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function beginAuthorization(input: {
  provider?: SubscriptionProvider
  name: string
  replace_id?: string
  proxy_id?: string
}) {
  return request('/api/accounts/oauth', authorizationSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
export function completeAuthorization(input: {
  state: string
  callback_url: string
}) {
  return request('/api/accounts/oauth/complete', accountSchema, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}
export function cancelAuthorization(state: string) {
  return request(
    `/api/accounts/oauth/${encodeURIComponent(state)}`,
    z.undefined(),
    { method: 'DELETE', body: '{}' },
  )
}
export function setAccountEnabled(input: { id: string; enabled: boolean }) {
  return request(
    `/api/accounts/${encodeURIComponent(input.id)}`,
    accountSchema,
    { method: 'PATCH', body: JSON.stringify({ enabled: input.enabled }) },
  )
}

export function bindAccountProxy(input: { id: string; proxy_id: string }) {
  return request(
    `/api/accounts/${encodeURIComponent(input.id)}/proxy`,
    accountSchema,
    { method: 'PUT', body: JSON.stringify({ proxy_id: input.proxy_id }) },
  )
}
const fingerprintProfileSchema = z.object({
  source: z.enum(['', 'learned', 'manual']).default(''),
  platform: z.string().max(160).default(''),
  os: z.string().max(32).default(''),
  arch: z.string().max(32).default(''),
  runtime_version: z.string().max(32).default(''),
  package_version: z.string().max(32).default(''),
})
const fingerprintSchema = z.object({
  provider: z.enum(['codex', 'claude']),
  profile: fingerprintProfileSchema,
  device_id: z.string().max(8).default(''),
})
export type AccountFingerprint = z.infer<typeof fingerprintSchema>
export type FingerprintInput = Omit<AccountFingerprint['profile'], 'source'>
export const fingerprintProviders = new Set(['codex', 'claude'])
export function fetchAccountFingerprint(id: string) {
  return request(
    `/api/accounts/${encodeURIComponent(id)}/fingerprint`,
    fingerprintSchema,
  )
}
export function saveAccountFingerprint(input: {
  id: string
  profile: FingerprintInput
}) {
  return request(
    `/api/accounts/${encodeURIComponent(input.id)}/fingerprint`,
    fingerprintSchema,
    { method: 'PUT', body: JSON.stringify(input.profile) },
  )
}
export function resetAccountFingerprint(input: {
  id: string
  device: boolean
}) {
  return request(
    `/api/accounts/${encodeURIComponent(input.id)}/fingerprint`,
    fingerprintSchema,
    { method: 'DELETE', body: JSON.stringify({ device: input.device }) },
  )
}
export function deleteAccount(id: string) {
  return request(`/api/accounts/${encodeURIComponent(id)}`, z.undefined(), {
    method: 'DELETE',
    body: '{}',
  })
}
export function checkAccount(id: string) {
  return request(
    `/api/accounts/${encodeURIComponent(id)}/check`,
    z.object({ account: accountSchema, models: modelsSchema }),
    { method: 'POST', body: '{}' },
  )
}

const messages = {
  demo_read_only: 'demoReadOnly',
  allocation_pool_locked: 'allocationAccountLocked',
  invalid_account_input: 'accountInvalidInput',
  account_exists: 'accountExists',
  account_identity_mismatch: 'accountIdentityMismatch',
  account_limit: 'accountLimitReached',
  account_disabled: 'accountDisabledHint',
  provider_disabled: 'providerDisabled',
  account_reauthorization_required: 'accountReauthorizeHint',
  account_refresh_failed: 'accountRefreshFailed',
  invalid_proxy_input: 'proxyInvalidInput',
  fingerprint_unsupported: 'fingerprintUnsupported',
  proxy_not_found: 'proxyNotFound',
  oauth_state_invalid: 'oauthStateInvalid',
  oauth_callback_invalid: 'oauthCallbackInvalid',
  oauth_access_denied: 'oauthAccessDenied',
  oauth_busy: 'accountBusy',
  gateway_busy: 'accountBusy',
  upstream_unavailable: 'accountUpstreamUnavailable',
  upstream_rejected_request: 'accountCheckFailed',
  upstream_rate_limited: 'accountRateLimited',
} as const
export function accountErrorKey(error: unknown) {
  const code = error instanceof ApiError ? error.code : ''
  return Object.hasOwn(messages, code)
    ? messages[code as keyof typeof messages]
    : 'accountActionFailed'
}

export function pollAuthorization(state: string, signal: AbortSignal) {
  return request(
    '/api/accounts/oauth/poll',
    z.object({
      account: accountSchema.optional(),
      interval: z.number().int().min(0).max(600),
    }),
    { method: 'POST', body: JSON.stringify({ state }), signal },
  )
}
