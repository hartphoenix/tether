import { migrateInstalledStartups } from "../src/cli/startup";
for (const result of await migrateInstalledStartups()) {
  if ("message" in result) console.log(`${result.profile}: ${result.message}`);
}
