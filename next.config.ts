import type { NextConfig } from 'next'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This project is a subdirectory of a home folder that has its own lockfile.
  // Without this, Next infers the wrong workspace root and traces the wrong
  // files into the serverless bundle.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The Panta key must never reach the browser. If it ever appears in a
  // NEXT_PUBLIC_* var, fail the build rather than shipping it.
  // See AGENTS.md rule 1.
  env: {
    NEXT_PUBLIC_SAFE_TO_SHIP: '1',
  },
}

export default nextConfig
