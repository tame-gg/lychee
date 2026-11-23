import type { LimitExcludeReason } from './types'

export interface NetworkLimitFact {
  metered: boolean
  excludeWhenLimited: boolean
  dataLimit?: number
  used: number
}

export function limitExcludeReason(fact: NetworkLimitFact): LimitExcludeReason | null {
  if (!fact.excludeWhenLimited) return null
  if (fact.metered) return 'metered'
  if (fact.dataLimit !== undefined && fact.used >= fact.dataLimit) return 'cap'
  return null
}

export function limitExclusions(
  facts: Record<string, NetworkLimitFact>
): Record<string, LimitExcludeReason> {
  const result: Record<string, LimitExcludeReason> = {}
  for (const [id, fact] of Object.entries(facts)) {
    const reason = limitExcludeReason(fact)
    if (reason) result[id] = reason
  }
  return result
}
