import type { ProviderConfig } from '../../types/provider'
import { isNativeRuntime } from './bridge'

/**
 * True when the app runs on the native backend, which can reach any provider
 * without browser CORS limits.
 */
export { isNativeRuntime }

/**
 * SenseNova and similar providers block browser CORS preflight. The native
 * bridge does not use the browser network stack, so a local proxy is only
 * needed when the same build is opened in a plain browser.
 */
export function providerNeedsUserProxy(provider: ProviderConfig | undefined): boolean {
  if (!provider) return false
  return !!provider.requiresProxy && !isNativeRuntime() && !provider.proxyUrl?.trim()
}
