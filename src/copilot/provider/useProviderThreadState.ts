import { useContext } from 'react'
import { ProviderThreadStateContext } from './ProviderThreadState'

export function useProviderThreadState() {
  const value = useContext(ProviderThreadStateContext)
  if (!value) {
    throw new Error('useProviderThreadState must be used within ProviderThreadStateProvider')
  }
  return value
}
