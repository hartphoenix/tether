![1.00](docs/assets/tether-banner-tagline.png)

# Tether

Tether is a local Markdown editor that works with your coding agent. It's crafted to improve your focus even when agentic work gets complex. Highlight a passage, leave a comment, and get a reply beside the text.

### The perennial focus problem

Your agent hands you a design document. Halfway through, you find a claim that needs more research, followed by a whole section you'd like to rethink. Meanwhile, you're still trying to parse the neuralese.

You might take this moment to start a list of changes in the chat, losing your flow as you bounce back and forth between the draft and the chat window. Or, you open the draft in an editor and just start making inline edits – losing track of your own words amid the agent's. (And when the agent re-reads the whole doc, it balloons your token spend while scattering the agent's attention).

### Threads that don't unravel

**Tether** fixes this with a Google-Docs-like workflow: highlight some text, write a question or todo, and keep going. Your comments collect in the sidebar, easy to find and edit. When you're ready, ask your agent to work through them. Its replies appear in those same threads, where you can keep discussing a point until you're satisfied.

Click "Resolve" on any thread you're done with, and it's hidden away. Quit the session and resume later with a different agent; anything unfinished will be there when you come back. There's even a file organizer with custom filters to help you keep multi-draft projects moving forward.

**Tether works in macOS with any coding agent** with access to your local files and Tether's CLI. It's designed primarily for use in [cmux](https://cmux.com/), with support for [Wave](https://www.waveterm.dev/) and separate browsers as well.

The macOS package includes everything Tether needs to run.

[Try Tether](#try-tether) · [Set up your agent](#agent-review-cli) · [CLI reference](docs/reference/cli.md)

## Try Tether

If your agent can install and run programs on your Mac, give it this:

```
Help me install Tether from https://github.com/hartphoenix/tether. Read the README and follow the packaged installation instructions for my Mac. Then open the getting-started guide so we can test drive it.
```

### Prefer the terminal?

Run this in your terminal:

```sh
bash -o pipefail -c 'curl --proto "=https" --proto-redir "=https" -fsSL https://github.com/hartphoenix/tether/releases/latest/download/install.sh | bash'
```

Once finished, the installer opens the [getting-started guide](docs/getting-started.md) for a practice exchange. If it prints a PATH command, run that to make `tether` available in your terminal. Setup follows your current supported terminal; `tether setup --host browser` selects a separate browser. See [host setup](docs/guide/hosts.md) for requirements and optional integrations.

Resume with `tether`, or use the **Open Tether.command** launcher at the path printed by the installer. To open a particular document:

```sh
tether open /path/to/doc.md
```

If an old tab can't connect, launch Tether again.

## Working in Tether

You and your agent can edit the same Markdown file and discuss individual passages in persistent threads. **Folio**, the document organizer, keeps active work together with project filters and pins. The archive preserves finished conversations in case you need them again.

The reader includes four themes: Tether Light, Tether Dark, Light Treason, and Dark Academia. You can also make your own themes, set custom colors, and link fonts from Google Fonts.

### Your files and conversations

Tether includes a WYSIWYG Markdown editor; any change to the document body saves automatically in that file. The app stores comments separately on your machine; opening or commenting on a file doesn't change its Markdown. Sharing the file alone doesn't share its comments. A `.tether` export lets you share the document with its open threads.

## Agent review CLI

The package includes the `tether` command. Agents use it under the same OS account and profile as the reader; `tether --help` lists the commands.

The [Tether review skill](integrations/agents/tether-review/SKILL.md) equips your agent for the review workflow, safe edits, and formatting. During agent-led setup, it asks whether you'd like the skill and handles installation if you say yes. If you installed Tether yourself, ask your agent to run `tether setup --help` and help you add the skill.

This optional skill is the easiest way to keep your agent's Tether instructions in step with the app. When you opt in, setup installs the version bundled with the package, and updates refresh it as those instructions change. **You're welcome to customize your copy of the skill**; during future updates, Tether will keep your edits and offer the new instructions for your review. This helps prevent stale instructions from steering future sessions; see [skill updates](docs/guide/agent-setup.md#skill-updates).

Agents can also use the [CLI reference](docs/reference/cli.md) directly. It covers reading only the relevant comments and document context, replying in threads, making safe edits, and registering finished documents in Folio.

## Help and development

Run `tether doctor` for installation and service diagnostics. [Host setup](docs/guide/hosts.md) covers terminal integration; [installation and recovery](docs/guide/installation.md) covers managed packages, updates, and backups.

Report problems in [GitHub Issues](https://github.com/hartphoenix/tether/issues), including your macOS and host/browser versions, what you tried, and what happened. See the [documentation map](docs/README.md) for guides and references, or [CONTRIBUTING.md](CONTRIBUTING.md) for source setup and checks.

Tether is maintained by [Hart the Phoenix](https://github.com/hartphoenix) and released under the [MIT license](LICENSE).
