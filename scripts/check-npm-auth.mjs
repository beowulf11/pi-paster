#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const registry = process.env.npm_config_registry || "https://registry.npmjs.org/";

function runNpm(args) {
  return execFileSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  const user = runNpm(["whoami", "--registry", registry]);
  console.log(`npm auth ok: logged in as ${user} (${registry})`);
} catch {
  console.error(`
Cannot publish pi-paster: npm is not authenticated for ${registry}.

Fix it with:
  npm login --registry=${registry} --auth-type=web
  npm whoami --registry=${registry}
  npm publish --access public

If web login fails, try:
  npm login --registry=${registry} --auth-type=legacy
`);
  process.exit(1);
}
