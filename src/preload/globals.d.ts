import type { LycheeApi } from './index'

declare global {
  interface Window {
    lychee: LycheeApi
  }
}
