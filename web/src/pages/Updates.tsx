import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { authOptions } from '@/lib/auth'
import {
  checkUpdate,
  installUpdate,
  updateError,
  updatePending,
  updatesOptions,
  type UpdateState,
} from '@/lib/updates'
import { useAdminMutation } from '@/hooks/use-admin-mutation'
import { Button } from '@/components/ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'

export function Updates() {
  const { data } = useQuery(authOptions())
  const user = data?.user
  return user?.role === 'admin' && user.id === 1 ? (
    <UpdateSettings key={user.id} userID={user.id} />
  ) : null
}

function UpdateSettings({ userID }: { userID: number }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const options = updatesOptions(client, userID)
  const query = useQuery(options)
  const [target, setTarget] = useState<string | null>(null)
  const [backup, setBackup] = useState(false)
  const apply = (data: UpdateState) =>
    client.setQueryData(options.queryKey, data)
  const refresh = () => client.invalidateQueries({ queryKey: options.queryKey })
  const check = useAdminMutation({
    userID,
    mutationFn: (_input: void, signal) => checkUpdate(signal),
    onSuccess: apply,
    onError: refresh,
  })
  const install = useAdminMutation({
    userID,
    mutationFn: installUpdate,
    onSuccess: (data) => {
      apply(data)
      setTarget(null)
    },
    onError: refresh,
  })
  const value = query.data
  const busy = value ? updatePending(value) : false
  const error = check.error ?? install.error
  const stableBuild = value && /^\d+\.\d+\.\d+$/.test(value.current_version)
  const result = value?.job
  const status =
    result?.status === 'succeeded' && result.version !== value?.current_version
      ? 'running'
      : result?.status
  const statusCopy = {
    queued: 'updateQueued',
    running: 'updateRunning',
    succeeded: 'updateSucceeded',
    failed: 'updateFailed',
    interrupted: 'updateInterrupted',
  } as const
  return (
    <section className="mt-8 space-y-6" aria-labelledby="software-update-title">
      <div>
        <h2 id="software-update-title" className="font-medium">
          {t('updatesTitle')}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {t('updatesDescription')}
        </p>
      </div>
      {query.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t('loading')}
        </p>
      ) : value ? (
        <>
          <dl className="grid gap-5 border-y border-border py-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('updateCurrent')}
              </dt>
              <dd className="mt-2 break-all font-mono tabular-nums" dir="ltr">
                {value.current_version || '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t('updateLatest')}
              </dt>
              <dd className="mt-2 font-mono tabular-nums" dir="ltr">
                {value.latest_version || '—'}
              </dd>
            </div>
          </dl>
          {!value.enabled && (
            <div className="space-y-2 text-sm leading-6">
              <p className="text-muted-foreground">{t('updateDisabled')}</p>
              <a
                className="text-foreground underline underline-offset-4"
                href="https://sublane.dev/docs/deployment#web-updates"
                target="_blank"
                rel="noreferrer"
              >
                {t('updateSetup')}
              </a>
            </div>
          )}
          {!stableBuild && (
            <p className="text-sm text-muted-foreground">
              {t('updateBuildUnsupported')}
            </p>
          )}
          {value.check_failed && (
            <p role="alert" className="text-sm text-error">
              {t('updateCheckFailed')}
            </p>
          )}
          {!value.available &&
            value.latest_version &&
            stableBuild &&
            !value.check_failed && (
              <p className="text-sm text-muted-foreground">
                {t('updateNoNew')}
              </p>
            )}
          {status && (
            <div
              className="space-y-2"
              role={
                status === 'failed' || status === 'interrupted'
                  ? 'alert'
                  : 'status'
              }
            >
              <p
                className={
                  status === 'failed' || status === 'interrupted'
                    ? 'text-sm text-error'
                    : 'text-sm'
                }
              >
                {t(statusCopy[status])}
              </p>
              {result && (
                <p
                  className="break-all font-mono text-xs text-muted-foreground"
                  dir="ltr"
                >
                  {result.version}
                </p>
              )}
              {busy && !value.enabled && (
                <p className="text-sm text-muted-foreground">
                  {t('updateWorkerLost')}
                </p>
              )}
              {status === 'succeeded' && (
                <Button
                  variant="outline"
                  onClick={() => window.location.reload()}
                >
                  {t('updateReload')}
                </Button>
              )}
            </div>
          )}
          {query.isError && (
            <p role="status" className="text-sm text-muted-foreground">
              {t(busy ? 'updateReconnecting' : 'updateRequestFailed')}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={check.isPending || install.isPending || busy}
              onClick={() => check.mutate()}
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t('updateCheck')}
            </Button>
            {value.enabled && value.available && (
              <Button
                disabled={busy || install.isPending}
                onClick={() => {
                  install.reset()
                  setBackup(false)
                  setTarget(value.latest_version)
                }}
              >
                {t('updateInstall', { version: value.latest_version })}
              </Button>
            )}
            {value.release_url && (
              <a
                className="text-sm underline underline-offset-4"
                href={value.release_url}
                target="_blank"
                rel="noreferrer"
              >
                {t('updateReleaseNotes')}
              </a>
            )}
          </div>
        </>
      ) : (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-error">{t('updateRequestFailed')}</p>
          <Button variant="outline" onClick={() => query.refetch()}>
            {t('reconnect')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-error">
          {t(updateError(error))}
        </p>
      )}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open && !install.isPending) setTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('updateConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('updateConfirmDescription', { version: target })}
            </DialogDescription>
          </DialogHeader>
          <a
            href="/admin/settings/backup"
            className="text-sm underline underline-offset-4"
          >
            {t('backupTitle')}
          </a>
          <label className="flex items-start gap-3 text-sm leading-6">
            <input
              className="mt-1 size-4 shrink-0 accent-primary"
              type="checkbox"
              checked={backup}
              onChange={(event) => setBackup(event.target.checked)}
            />
            {t('updateBackupConfirm')}
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={install.isPending}
              onClick={() => setTarget(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              disabled={
                !backup ||
                install.isPending ||
                busy ||
                !value?.enabled ||
                !value.available ||
                target !== value.latest_version
              }
              onClick={() => {
                if (target) install.mutate(target)
              }}
            >
              {t('updateConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
