import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { LoaderCircle } from 'lucide-react'
import {
  allocationDeleteErrorKey,
  deleteScheme,
  type Scheme,
} from '@/lib/allocations'
import { Button } from './ui/Button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/Dialog'

export function DeleteAllocation({
  scheme,
  onClose,
  onDeleted,
}: {
  scheme: Pick<Scheme, 'id' | 'name'>
  onClose: () => void
  onDeleted: () => Promise<void>
}) {
  const { t } = useTranslation()
  const mutation = useMutation({
    mutationFn: () => deleteScheme(scheme.id),
    onSuccess: async () => {
      await onDeleted()
      onClose()
    },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose()
      }}
    >
      <DialogContent
        className="[@media(pointer:coarse)]:[&_button]:min-h-11"
        showCloseButton={false}
        onInteractOutside={(event) => {
          if (mutation.isPending) event.preventDefault()
        }}
        onEscapeKeyDown={(event) => {
          if (mutation.isPending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('allocationDeleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('allocationDeleteDescription', { name: scheme.name })}
          </DialogDescription>
        </DialogHeader>
        {mutation.isError && (
          <p role="alert" className="text-sm text-error">
            {t(allocationDeleteErrorKey(mutation.error))}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={mutation.isPending}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
          >
            {mutation.isPending && (
              <LoaderCircle
                className="motion-safe:animate-spin"
                aria-hidden="true"
              />
            )}
            {t('allocationDelete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
