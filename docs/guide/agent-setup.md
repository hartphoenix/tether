# Agent setup

[Documentation](../README.md) · [CLI reference](../reference/cli.md)

Tether bundles two optional agent skills:

- The [review skill](../../integrations/agents/tether-review/SKILL.md) (`tether-review`) teaches your agent to work through comments, edit documents safely and add finished documents to Folio.
- [Tetherball](../../integrations/agents/tetherball/SKILL.md) (`/tetherball`) helps your agent develop a shared document with you over a long inquiry, such as research, learning, diagnosis or planning. It depends on the review skill, so installing it installs both.

Your agent needs access to your local files and the `tether` command, running under the same macOS account and Tether profile as your reader. Plain `tether setup` installs neither skill.

## Install the skills

Ask your agent to install the skills. With your agreement, it finds its skills directory and runs:

```sh
tether setup --agent-directory /absolute/path/to/skills --skills tetherball --no-open
```

`--skills tetherball` installs both skills. `--skills tether-review` installs the review skill alone, which is also what setup does when you omit `--skills`. Setup registers each installed skill for updates separately.

Agents: if the user already agreed during setup, don't ask again. If you can't determine your skills directory, ask the user. The setup command never prompts for input, and it won't overwrite installed instructions that differ from the bundled copy.

Tether also offers Tetherball at the top of the release notes it opens after you install or update. **Read the SKILL.md** opens the bundled instructions in a new reader tab. **Install Tetherball** installs it in a skills directory you've already registered with Tether, and lets you choose when you've registered several; your review skill and its customizations stay as they are. If no directory is registered, **Copy setup prompt** copies a prompt you can give your agent so it can choose a destination. **Not now** dismisses the offer, and you can still install the skill later with the command above.

## Skill updates

Setup records each skill's identity, path and content hash, and review skills registered by older versions migrate automatically. Each package update checks registered skills and refreshes any copy you haven't edited. If you've customized a copy, the update leaves it in place.

When a customized copy needs your review, readers and Folio show **Review agent instructions**. Choose it to compare your installed copy with the proposed instructions, then pick one:

- **Accept new version** replaces your copy with the version you reviewed and resumes automatic updates.
- **Keep old version** leaves your copy alone and dismisses this proposal. Tether asks again only when the bundled instructions change.
- **Ask my agent to merge** copies a prompt for your agent. Paste it into your agent chat; the agent reads the release notes, compares the two versions and asks about any preferences it needs to understand. You review and approve the merge in that conversation, and the agent installs it and clears the notice.

Before applying your choice, Tether checks that both files still match what you reviewed. It then records the decision and clears the notice, so you don't need to find or delete proposal files. Tether continues to protect the customizations in a merged copy during later updates. To decide later, close the comparison.

Leaving a comment doesn't start an agent turn. When you're ready, ask your agent to review the document, as shown in [getting started](../getting-started.md). If your agents keep turn watchers armed, as the review skill describes, each one gets a **Go** button at the bottom of the threads drawer that starts its next turn.
