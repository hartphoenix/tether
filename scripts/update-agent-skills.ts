import { updateAgentSkills } from "../src/cli/agent-skills";
import { resolveConfig } from "../src/server/config";

// Skill maintenance must not turn an already installed app update into a failure.
try {
  for (const warning of await updateAgentSkills(resolveConfig())) console.log(warning);
} catch (cause) {
  console.log(`Tether was installed, but its agent skill update needs attention: ${(cause as Error).message}`);
}
