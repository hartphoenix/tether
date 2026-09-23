# Agent setup

[Documentation](../README.md) · [CLI reference](../reference/cli.md)

Give your agent the optional [review skill](../../integrations/agents/tether-review/SKILL.md) to help it work through comments, edit safely, and add documents to Folio. It needs access to your local files and CLI under the same OS account and profile as the reader.

## Install the skill

Ask your agent to install the skill. Once you agree, it should find its skills directory and run:

```sh
tether setup --agent-directory /absolute/path/to/skills --no-open
```

Agents: if the user already agreed during setup, don't ask again. Ask for the skills directory if you can't determine it. The setup command doesn't prompt for input, and it refuses to overwrite instructions that differ from the bundled copy. Plain `tether setup` does not install a skill.

## Skill updates

Setup records the skill's path and a hash of its contents. Each package update checks registered skills automatically and refreshes your copy if you haven't edited it. A customized copy stays in place while the app update finishes.

If your customized copy needs review, readers and Folio show **Review agent instructions**. Choose it to compare your installed copy with the proposed instructions, then choose how to proceed:

- **Accept new version** replaces your copy with the version you reviewed and resumes automatic updates.
- **Keep old version** leaves your copy alone and dismisses this proposal. Tether asks again only when the bundled instructions change.
- **Ask my agent to merge** copies a prompt for your agent. Paste it into your agent chat. The agent reads the release notes, compares the instructions, and asks about any preferences or configuration it needs to understand. Review and approve the merge in that conversation; the agent installs it and clears the notice without sending you back to Tether.

Tether checks that the files still match what you reviewed before applying your choice. It records the decision and clears the notice; you don't need to find or delete proposal files. Any customizations in a merged copy stay protected during future updates. Close the comparison to decide later.

Leaving a comment does not start an agent turn. Ask the agent to review when you are ready, as shown in [getting started](../getting-started.md).
