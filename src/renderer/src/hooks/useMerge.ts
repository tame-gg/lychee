import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

export function useMergeEvents(): void {
  const receiveMergeState = useAppStore((store) => store.receiveMergeState)

  useEffect(() => {
    const unsubscribe = window.lychee.onMergeState(receiveMergeState)
    void window.lychee
      .mergeState()
      .then(receiveMergeState)
      .catch(() => {})
    return unsubscribe
  }, [receiveMergeState])
}
