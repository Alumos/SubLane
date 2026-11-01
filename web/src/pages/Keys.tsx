import { Pagination } from '@/components/Pagination'
import { TableViewport } from '@/components/TableViewport'
import { useTablePagination } from '@/lib/pagination'
import { useEffect, useRef, useState } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { KeyRound, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { authOptions } from '@/lib/auth'
import { keyOptions, keyState } from '@/lib/keys'
import { CreateKey } from '@/components/CreateKey'
import { CatalogDialog } from '@/components/CatalogDialog'
import { CopyKey } from '@/components/CopyKey'
import { ClientGuide } from '@/components/ClientGuide'
import { CCSwitchImport } from '@/components/CCSwitchImport'
import { MagpieImport } from '@/components/MagpieImport'
import { RevokeKey } from '@/components/RevokeKey'
import { EditKey } from '@/components/EditKey'
import { KeyGroup } from '@/components/KeyGroup'
import { Status } from '@/components/Status'
import { Button } from '@/components/ui/Button'
import { formatInstanceDate, useTimeZone } from '@/lib/timezone'

export function Keys() {
  const { data } = useQuery(authOptions())
  if (!data?.user) return null
  // A cross-tab identity change must unmount dialogs as well as clear query data, including any displayed secret.
  return <KeyManager key={data.user.id} userID={data.user.id} />
}

function KeyManager({ userID }: { userID: number }) {
  const { t, i18n } = useTranslation()
  const timeZone = useTimeZone()
  const client = useQueryClient()
  const heading = useRef<HTMLHeadingElement>(null)
  const { page, pageSize, viewport, changePage, changePageSize, syncPage } =
    useTablePagination()
  const [includeRevoked, setIncludeRevoked] = useState(false)
  const [revokedName, setRevokedName] = useState('')
  const [bindingNotice, setBindingNotice] = useState<{
    restored: boolean
    name: string
  } | null>(null)
  const query = useQuery({
    ...keyOptions(client, userID, page, includeRevoked, pageSize),
    placeholderData: keepPreviousData,
  })
  syncPage(query.data?.page, query.isPlaceholderData)
  const [clock, setClock] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const now = query.data
    ? query.data.server_time + Math.max(0, clock - query.dataUpdatedAt) / 1000
    : clock / 1000
  const invalidate = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['keys', userID] }),
      client.invalidateQueries({ queryKey: ['connection', userID] }),
      client.invalidateQueries({ queryKey: ['system'] }),
      client.invalidateQueries({ queryKey: ['model-catalog', userID] }),
      client.invalidateQueries({ queryKey: ['model-availability', userID] }),
    ])
  }
  const dates = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
    timeZone,
    dateStyle: 'medium',
  })
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 ref={heading} tabIndex={-1} className="page-title outline-none">
            {t('apiKeys')}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ClientGuide userID={userID} />
          <CreateKey
            userID={userID}
            onCreated={() => {
              setRevokedName('')
              setBindingNotice(null)
              changePage(1)
              return invalidate()
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <p
          data-tour="access"
          tabIndex={-1}
          className="text-sm leading-6 text-muted-foreground"
        >
          {t('gatewayKeysNotice')}
        </p>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            checked={includeRevoked}
            onChange={(event) => {
              setIncludeRevoked(event.target.checked)
              changePage(1)
            }}
          />
          <span
            aria-hidden="true"
            className="relative h-5 w-9 shrink-0 rounded-full bg-muted-foreground/30 transition-colors after:absolute after:left-0.5 after:top-0.5 after:size-4 after:rounded-full after:bg-background after:transition-transform peer-checked:bg-primary peer-checked:after:translate-x-4 peer-checked:after:bg-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:after:transition-none"
          />
          <span>{t('showRevokedKeys')}</span>
        </label>
      </div>
      {revokedName && (
        <p role="status" className="break-words text-sm text-success">
          {t('keyRevokedNotice', { name: revokedName })}
        </p>
      )}
      {bindingNotice && (
        <p role="status" className="break-words text-sm text-success">
          {t(
            bindingNotice.restored
              ? 'keyRestoredNotice'
              : 'keyGroupChangedNotice',
            { name: bindingNotice.name },
          )}
        </p>
      )}
      {query.isPending ? (
        <p
          role="status"
          className="flex items-center gap-2 py-10 text-sm text-muted-foreground"
        >
          <LoaderCircle
            className="size-4 motion-safe:animate-spin"
            aria-hidden="true"
          />
          {t('loadingKeys')}
        </p>
      ) : query.isError ? (
        <div
          role="alert"
          className="space-y-4 rounded-xl border border-border p-6"
        >
          <p className="text-sm text-error">{t('keysLoadFailed')}</p>
          <Button
            variant="outline"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            {t('reconnect')}
          </Button>
        </div>
      ) : query.data.keys.length === 0 ? (
        <section className="flex flex-col items-center rounded-xl border border-dashed border-border p-10 text-center">
          <KeyRound
            className="mb-4 size-8 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="font-medium">
            {t(includeRevoked ? 'noKeys' : 'noUnrevokedKeys')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(
              includeRevoked
                ? 'noKeysDescription'
                : 'noUnrevokedKeysDescription',
            )}
          </p>
        </section>
      ) : (
        <TableViewport ref={viewport} aria-busy={query.isFetching}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted-foreground">
              <tr>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('keyName')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('memberStatus')}
                </th>
                <th scope="col" className="px-5 py-3 font-medium">
                  {t('keyLastUsed')}
                </th>
                <th scope="col" className="px-5 py-3 text-right font-medium">
                  {t('actions')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {query.data.keys.map((key) => (
                <tr key={key.id}>
                  <td className="min-w-48 max-w-64 px-5 py-4">
                    <p className="break-words font-medium">{key.name}</p>
                    <div className="mt-1 flex items-start gap-1">
                      <p className="min-w-0 break-words text-xs text-muted-foreground">
                        {t('keyGroupName', {
                          name: key.group_name,
                        })}
                      </p>
                      <KeyGroup
                        value={key}
                        userID={userID}
                        onSaved={async () => {
                          setRevokedName('')
                          setBindingNotice({ restored: false, name: key.name })
                          await invalidate()
                        }}
                      />
                    </div>
                    <CopyKey
                      key={String(key.copyable)}
                      value={key}
                      userID={userID}
                    />
                    <div className="-ml-2 mt-1">
                      <CatalogDialog
                        target={{ kind: 'key', id: key.id }}
                        name={key.name}
                        disabled={keyState(key, now) !== 'active'}
                      />
                    </div>
                  </td>
                  <td className="min-w-56 px-5 py-4">
                    <Status
                      kind={
                        keyState(key, now) === 'active'
                          ? 'success'
                          : [
                                'keyExpired',
                                'keyGroupUnavailable',
                                'keyAllocationRequired',
                              ].includes(keyState(key, now))
                            ? 'warning'
                            : 'neutral'
                      }
                    >
                      {t(keyState(key, now))}
                    </Status>
                    {keyState(key, now) === 'keyAllocationRequired' && (
                      <div className="max-w-64">
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">
                          {t(
                            key.can_restore
                              ? 'keyAllocationHint'
                              : 'keyRestoreUnavailable',
                          )}
                        </p>
                        {key.can_restore && (
                          <KeyGroup
                            value={key}
                            userID={userID}
                            restore
                            onSaved={async () => {
                              setRevokedName('')
                              setBindingNotice({
                                restored: true,
                                name: key.name,
                              })
                              await invalidate()
                              heading.current?.focus()
                            }}
                          />
                        )}
                      </div>
                    )}
                    <p
                      className="mt-2 whitespace-nowrap text-xs text-muted-foreground"
                      title={
                        key.expires_at === null
                          ? undefined
                          : formatInstanceDate(
                              key.expires_at * 1000,
                              i18n.resolvedLanguage ?? 'en',
                              timeZone,
                              { dateStyle: 'short', timeStyle: 'medium' },
                            )
                      }
                    >
                      {key.expires_at === null
                        ? t('keyNeverExpires')
                        : t('keyExpiresOn', {
                            date: dates.format(key.expires_at * 1000),
                          })}
                    </p>
                  </td>
                  <td className="whitespace-nowrap px-5 py-4 text-muted-foreground">
                    {key.last_used_at === null
                      ? t('neverUsed')
                      : dates.format(key.last_used_at * 1000)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <ClientGuide
                        value={key}
                        userID={userID}
                        disabled={keyState(key, now) !== 'active'}
                      />
                      <CCSwitchImport
                        value={key}
                        userID={userID}
                        usable={keyState(key, now) === 'active'}
                      />
                      <MagpieImport
                        value={key}
                        userID={userID}
                        usable={keyState(key, now) === 'active'}
                      />
                      <EditKey value={key} onSaved={invalidate} />
                      <RevokeKey
                        value={key}
                        onRevoked={() => {
                          setRevokedName(key.name)
                          setBindingNotice(null)
                          // Keep the remaining usable keys visible after removing a row.
                          changePage(1)
                          return invalidate()
                        }}
                        focusAfterRevoke={() => heading.current?.focus()}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
      {query.data && (
        <Pagination
          page={query.data.page}
          pageSize={query.data.page_size}
          total={query.data.total}
          disabled={query.isFetching}
          onPageChange={changePage}
          onPageSizeChange={changePageSize}
        />
      )}
    </div>
  )
}
