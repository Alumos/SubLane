import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRightLeft, ChevronDown, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { availableGroupOptions } from '@/lib/groups'
import { rebindKey, type APIKey } from '@/lib/keys'
import { ApiError } from '@/lib/request'
import { Button } from './ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/Dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/DropdownMenu'

export function KeyGroup({
  value,
  userID,
  restore = false,
  onSaved,
}: {
  value: APIKey
  userID: number
  restore?: boolean
  onSaved: () => Promise<void>
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={restore ? 'outline' : 'ghost'}
          size={restore ? 'sm' : 'icon'}
          className={
            restore
              ? 'mt-3'
              : '-my-1 size-6 text-muted-foreground [@media(pointer:coarse)]:min-w-11'
          }
          disabled={value.revoked_at !== null}
          aria-label={t(restore ? 'restoreKeyNamed' : 'changeKeyGroupNamed', {
            name: value.name,
          })}
          title={t(restore ? 'restoreKey' : 'changeKeyGroup')}
        >
          {restore ? (
            t('restoreKey')
          ) : (
            <ArrowRightLeft className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </DialogTrigger>
      {open && (
        <BindingForm
          value={value}
          userID={userID}
          restore={restore}
          onSaved={onSaved}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  )
}

function BindingForm({
  value,
  userID,
  restore,
  onSaved,
  onClose,
}: {
  value: APIKey
  userID: number
  restore: boolean
  onSaved: () => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const options = availableGroupOptions(client, userID)
  const choices = useQuery(restore ? { ...options, enabled: false } : options)
  const [groupID, setGroupID] = useState(value.group_id)
  const group = choices.data?.groups.find((item) => item.id === groupID)
  const mutation = useMutation({
    mutationFn: rebindKey,
    onSuccess: async () => {
      onClose()
      await onSaved()
    },
    onError: async (error) => {
      if (
        !restore &&
        error instanceof ApiError &&
        error.code === 'group_unavailable'
      )
        await choices.refetch()
    },
  })
  const label = (item: NonNullable<typeof group>) =>
    item.scheme_id
      ? t('allocationKeyChoice', { scheme: item.scheme_name, pool: item.name })
      : item.name
  return (
    <DialogContent
      showCloseButton={false}
      className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      onInteractOutside={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
      onEscapeKeyDown={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {t(restore ? 'restoreKey' : 'changeKeyGroup')}
        </DialogTitle>
        <DialogDescription>
          {t(restore ? 'restoreKeyDescription' : 'changeKeyGroupDescription', {
            name: value.group_name,
          })}
        </DialogDescription>
      </DialogHeader>
      {!restore && (
        <div className="space-y-2">
          <p id="binding-group-label" className="text-sm font-medium">
            {t('keyGroup')}
          </p>
          {choices.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('loadingGroups')}
            </p>
          ) : choices.isError ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-error">{t('groupsLoadFailed')}</p>
              <Button
                variant="outline"
                disabled={choices.isFetching}
                onClick={() => choices.refetch()}
              >
                {t('reconnect')}
              </Button>
            </div>
          ) : choices.data.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('noAvailableGroups')}
            </p>
          ) : (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  className="h-auto min-h-9 w-full justify-between text-start"
                  aria-label={t('keyGroup')}
                  disabled={mutation.isPending}
                >
                  <span className="min-w-0 whitespace-normal break-words">
                    {group ? label(group) : t('chooseGroup')}
                  </span>
                  <ChevronDown className="shrink-0" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="max-h-64 w-(--radix-dropdown-menu-trigger-width) overflow-y-auto"
                aria-labelledby="binding-group-label"
              >
                <DropdownMenuRadioGroup
                  value={group ? String(group.id) : ''}
                  onValueChange={(id) => setGroupID(Number(id))}
                >
                  {choices.data.groups.map((item) => (
                    <DropdownMenuRadioItem
                      key={item.id}
                      value={String(item.id)}
                      className="items-start"
                    >
                      <span className="min-w-0 whitespace-normal break-words">
                        {label(item)}
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
      {mutation.isError && (
        <p role="alert" className="text-sm leading-6 text-error">
          {t(
            mutation.error instanceof ApiError &&
              mutation.error.code === 'group_unavailable'
              ? 'keyGroupUnavailableHint'
              : mutation.error instanceof ApiError &&
                  mutation.error.code === 'api_key_revoked'
                ? 'keyAlreadyRevoked'
                : 'keyGroupChangeFailed',
          )}
        </p>
      )}
      <DialogFooter>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          {t('cancel')}
        </Button>
        <Button
          disabled={
            mutation.isPending ||
            (!restore &&
              (!group || choices.isError || group.id === value.group_id))
          }
          onClick={() =>
            mutation.mutate({
              id: value.id,
              group_id: restore ? value.group_id : groupID,
            })
          }
        >
          {mutation.isPending && (
            <LoaderCircle
              className="motion-safe:animate-spin"
              aria-hidden="true"
            />
          )}
          {t(restore ? 'restoreKey' : 'saveChanges')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
