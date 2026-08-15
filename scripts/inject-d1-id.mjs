#!/usr/bin/env node
// Writes the D1 database id into the *generated* Worker config.
//
// wrangler.jsonc deliberately omits `database_id` so a public repo carries no
// account-specific ids, and wrangler has no environment-variable interpolation
// inside its config files. The Vite plugin emits dist/planning_poker/wrangler.json
// at build time; that file is gitignored, so it is the right place to inject.
//
// Run after `vite build` and before any remote wrangler command.

import { readFile, writeFile } from "node:fs/promises";

const CONFIG = "dist/planning_poker/wrangler.json";
const BINDING = "DB";

const id = process.env.D1_DATABASE_ID?.trim();
if (!id) {
  console.error(
    "D1_DATABASE_ID is not set. Remote deploys need it because wrangler.jsonc\n" +
      "omits database_id on purpose. Get it from `wrangler d1 list`, then set it\n" +
      "as a GitHub Actions variable (CI) or export it (local deploy).",
  );
  process.exit(1);
}

let config;
try {
  config = JSON.parse(await readFile(CONFIG, "utf8"));
} catch (error) {
  console.error(
    `Could not read ${CONFIG}. Run \`npm run build\` first.\n${String(error)}`,
  );
  process.exit(1);
}

const binding = config.d1_databases?.find((entry) => entry.binding === BINDING);
if (!binding) {
  console.error(
    `${CONFIG} has no D1 binding named ${BINDING}. The generated config no longer\n` +
      "matches wrangler.jsonc — check the d1_databases section there.",
  );
  process.exit(1);
}

binding.database_id = id;
await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Injected D1_DATABASE_ID into ${CONFIG} (binding ${BINDING}).`);
