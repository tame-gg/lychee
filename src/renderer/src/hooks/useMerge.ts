import { useEffect } from 'react'
import { mergeBackend, useAppStore } from '../store/useAppStore'

export function useMergeEvents(): void {
  const receiveMergeState = useAppStore((store) => store.receiveMergeState)

  useEffect(() => {
    const unsubscribe = mergeBackend.onMergeState(receiveMergeState)
    void mergeBackend
      .mergeState()
      .then(receiveMergeState)
      .catch(() => {})
    return unsubscribe
  }, [receiveMergeState])
}
