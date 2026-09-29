/**
 * Archive sources. Add a provider here when another wearable API is supported.
 * The webhook handler and D1 repository do not import Polar modules directly.
 */

import { polarArchiveProvider } from "./polar/adapter.js";
import type { ArchiveProvider } from "./types.js";

export const archiveProviders: readonly ArchiveProvider[] = [polarArchiveProvider];

export function providerForSource(source: string): ArchiveProvider | undefined {
  return archiveProviders.find((provider) => provider.source === source);
}
