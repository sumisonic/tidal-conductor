// Load ./.env into process.env if it exists (silently), before tsx loads the entry file.
// Used by the pnpm scripts as `node --import ./scripts/env.mjs --import tsx <entry>`.
// No dotenv dependency: Node >= 21.7 has process.loadEnvFile.
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')
