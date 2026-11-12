import { useState, type FormEvent } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  accountErrorKey,
  fetchAccountFingerprint,
  resetAccountFingerprint,
  saveAccountFingerprint,
  type Account,
  type AccountFingerprint as Fingerprint,
  type FingerprintIdentity,
  type FingerprintInput,
} from '@/lib/accounts'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/Dialog'

const empty: FingerprintInput = {
  platform: '',
  os: '',
  arch: '',
  runtime_version: '',
  package_version: '',
}
// The Stainless values the Anthropic SDK reports on the platforms Claude Code runs on.
const claudeOS = ['MacOS', 'Windows', 'Linux', 'FreeBSD']
const claudeArch = ['arm64', 'x64', 'x86', 'arm']
const modes = ['off', 'device', 'session', 'full'] as const
const modeHints = {
  off: 'fingerprintModeOffHint',
  device: 'fingerprintModeDeviceHint',
  session: 'fingerprintModeSessionHint',
  full: 'fingerprintModeFullHint',
} as const
const modeLabels = {
  off: 'fingerprintModeOff',
  device: 'fingerprintModeDevice',
  session: 'fingerprintModeSession',
  full: 'fingerprintModeFull',
} as const
const noIdentity: FingerprintIdentity = { mode: 'off', tls: false }
const selectClass =
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50'

function profileInput(fingerprint: Fingerprint): FingerprintInput {
  const { platform, os, arch, runtime_version, package_version } =
    fingerprint.profile
  return { platform, os, arch, runtime_version, package_version }
}

export function AccountFingerprint({
  account,
  onClose,
  restoreFocus,
}: {
  account: Pick<Account, 'id' | 'name'>
  onClose: () => void
  restoreFocus: () => void
}) {
  const { t } = useTranslation()
  const query = useQuery({
    queryKey: ['account-fingerprint', account.id],
    queryFn: () => fetchAccountFingerprint(account.id),
  })
  // Edits start from the stored fingerprint; null means the form shows the stored values.
  const [edited, setValues] = useState<FingerprintInput | null>(null)
  const values = edited ?? (query.data ? profileInput(query.data) : empty)
  const [editedIdentity, setIdentity] = useState<FingerprintIdentity | null>(
    null,
  )
  const identity = editedIdentity ?? query.data?.identity ?? noIdentity
  const [device, setDevice] = useState(false)
  const save = useMutation({
    mutationFn: saveAccountFingerprint,
    onSuccess: onClose,
  })
  const reset = useMutation({
    mutationFn: resetAccountFingerprint,
    onSuccess: () => {
      setValues(null)
      setIdentity(null)
      setDevice(false)
      return query.refetch()
    },
  })
  const busy = save.isPending || reset.isPending
  const failure = save.error ?? reset.error
  const set = (key: keyof FingerprintInput) => (value: string) =>
    setValues({ ...values, [key]: value })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!query.data || busy) return
    reset.reset()
    const profile = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, value.trim()]),
    ) as FingerprintInput
    save.mutate({ id: account.id, profile, identity })
  }
  const source = query.data?.profile.source ?? ''
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('accountFingerprint')}</DialogTitle>
          <DialogDescription>
            {account.name} · {t('accountFingerprintHint')}
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('loadingFingerprint')}
          </p>
        ) : query.isError ? (
          <div role="alert" className="space-y-2 text-sm text-error">
            <p>{t(accountErrorKey(query.error))}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => query.refetch()}
            >
              {t('reconnect')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5" noValidate>
            <p className="text-sm">
              {t(
                source === 'learned'
                  ? 'fingerprintSourceLearned'
                  : source === 'manual'
                    ? 'fingerprintSourceManual'
                    : 'fingerprintSourceNone',
              )}
            </p>
            {query.data.provider === 'codex' ? (
              <div className="space-y-2">
                <label
                  htmlFor="fingerprint-platform"
                  className="text-sm font-medium"
                >
                  {t('fingerprintCodexPlatform')}
                </label>
                <Input
                  id="fingerprint-platform"
                  value={values.platform}
                  onChange={(event) => set('platform')(event.target.value)}
                  placeholder="(Mac OS 15.5.0; arm64) iTerm.app/3.6.1"
                  aria-describedby="fingerprint-platform-hint"
                  maxLength={160}
                  disabled={busy}
                />
                <p
                  id="fingerprint-platform-hint"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t('fingerprintCodexPlatformHint')}
                </p>
                <label
                  htmlFor="fingerprint-mode"
                  className="block pt-2 text-sm font-medium"
                >
                  {t('fingerprintConvergence')}
                </label>
                <select
                  id="fingerprint-mode"
                  value={identity.mode}
                  onChange={(event) =>
                    setIdentity({
                      ...identity,
                      mode: event.target.value as FingerprintIdentity['mode'],
                    })
                  }
                  aria-describedby="fingerprint-mode-hint"
                  disabled={busy}
                  className={selectClass}
                >
                  {modes.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(modeLabels[mode])}
                    </option>
                  ))}
                </select>
                <div
                  id="fingerprint-mode-hint"
                  className="space-y-1 text-xs leading-5 text-muted-foreground"
                >
                  <p>{t(modeHints[identity.mode])}</p>
                  {identity.mode !== 'off' && (
                    <p className="text-warning">
                      {t('fingerprintConvergenceWarning')}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ['os', 'fingerprintClaudeOS', claudeOS],
                      ['arch', 'fingerprintClaudeArch', claudeArch],
                    ] as const
                  ).map(([key, label, options]) => (
                    <div key={key} className="space-y-2">
                      <label
                        htmlFor={`fingerprint-${key}`}
                        className="text-sm font-medium"
                      >
                        {t(label)}
                      </label>
                      <select
                        id={`fingerprint-${key}`}
                        value={values[key]}
                        onChange={(event) => set(key)(event.target.value)}
                        disabled={busy}
                        className={selectClass}
                      >
                        <option value="">{t('fingerprintAutomatic')}</option>
                        {options.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  {(
                    [
                      [
                        'runtime_version',
                        'fingerprintRuntimeVersion',
                        'v26.3.0',
                      ],
                      [
                        'package_version',
                        'fingerprintPackageVersion',
                        '0.112.1',
                      ],
                    ] as const
                  ).map(([key, label, placeholder]) => (
                    <div key={key} className="space-y-2">
                      <label
                        htmlFor={`fingerprint-${key}`}
                        className="text-sm font-medium"
                      >
                        {t(label)}
                      </label>
                      <Input
                        id={`fingerprint-${key}`}
                        value={values[key]}
                        onChange={(event) => set(key)(event.target.value)}
                        placeholder={`${t('fingerprintAutomatic')} · ${placeholder}`}
                        maxLength={32}
                        disabled={busy}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('fingerprintClaudeHint')}
                </p>
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={identity.tls}
                    onChange={(event) =>
                      setIdentity({ ...identity, tls: event.target.checked })
                    }
                    aria-describedby="fingerprint-tls-hint"
                    disabled={busy}
                    className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>{t('fingerprintTLS')}</span>
                </label>
                <p
                  id="fingerprint-tls-hint"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t('fingerprintTLSHint')}
                </p>
              </div>
            )}
            {(query.data.provider === 'claude' ||
              query.data.identity.mode !== 'off') && (
              <div className="space-y-2">
                {query.data.device_id && (
                  <p className="text-sm">
                    {t(
                      query.data.provider === 'codex'
                        ? 'fingerprintInstallation'
                        : 'fingerprintDevice',
                    )}
                    : <code className="font-mono">{query.data.device_id}…</code>
                  </p>
                )}
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={device}
                    onChange={(event) => setDevice(event.target.checked)}
                    aria-describedby="fingerprint-device-hint"
                    disabled={busy}
                    className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>
                    {t(
                      query.data.provider === 'codex'
                        ? 'fingerprintResetInstallation'
                        : 'fingerprintResetDevice',
                    )}
                  </span>
                </label>
                <p
                  id="fingerprint-device-hint"
                  className="text-xs leading-5 text-muted-foreground"
                >
                  {t('fingerprintResetDeviceHint')}
                </p>
              </div>
            )}
            {failure && (
              <p role="alert" className="text-sm text-error">
                {t(accountErrorKey(failure))}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="sm:mr-auto"
                disabled={busy}
                onClick={() => {
                  save.reset()
                  reset.mutate({ id: account.id, device })
                }}
              >
                {reset.isPending && (
                  <LoaderCircle
                    className="motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t('resetFingerprint')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={busy}
              >
                {t('cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {save.isPending && (
                  <LoaderCircle
                    className="motion-safe:animate-spin"
                    aria-hidden="true"
                  />
                )}
                {t('saveFingerprint')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
