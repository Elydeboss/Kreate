/**
 * Entry point for running TypeScript sources under plain Node.
 *
 *   node --import ./scripts/register-ts.mjs scripts/verify-resilience.ts
 *
 * Node 24 strips types natively; this only installs the resolve hook that
 * teaches it about extensionless relative imports.
 */

import { register } from 'node:module'

register('./ts-resolve-hooks.mjs', import.meta.url)
