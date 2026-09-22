# getting started with **tether**

Tether turns Markdown files into a conversation surface, keeping your attention clear and focused in long AI-driven projects. Here's how use it:

1. **Try a comment.** Highlight any sentence of this document, choose **Comment** (the rightmost button) in the tooltip menu, and ask your agent a question or give an instruction.

   * You can leave dozens of comments on the same doc before the next turn. Your agent gets them all, each with its surrounding context, using Tether's CLI tool.
   * Each comment starts a **thread**. Since one document can spawn many subtasks, comment threads keep both you and your agent from merging or forgetting any work.
   * The **Threads drawer**, opened via the top-right button in this window, shows all the open threads on a doc.

2. **Prompt your agent.** Tether is designed to collect your comments without activating an agent turn on every one. Once you want your agent to respond, say something like:

   > review tether comments on `{{DOCUMENT_PATH}}`

   (To get the file path to a doc, open the Threads drawer and click the "Copy file path" button. If your agent already has the doc in context, no need to give it the path.)

3. **Continue the thread(s).** Your agent will use context clues for each thread:
   * If a comment needs a response, your agent will reply in the thread; notification badge will appear on the threads button.
   * If a comment requires revision, your agent will edit the document text itself. (This may "orphan" the comment if its highlighted text changes, but the thread will still be visible in the threads drawer)
   * If a comment raises an issue that pertains to the whole conversation, your agent will reply inline in the conversation.

Your Markdown stays in its original file. Comments are kept separate as private local data and aren't included when you share the file. Use **Export with annotations** to share open threads in a `.tether` package, and **Import annotations** (found in the folio) to add a `.tether` package from elsewhere.

# using the **folio**

Tether comes with an organizer called **folio**. To access the folio:

* in **cmux**, enable the **dock** in **settings > beta features > dock**, then use the hotkey `⌘-⌥-B` to hide/show folio. (The first time you use it, you may have to navigate to **dock > Tether Folio**. If the folio tab gets closed or quits unexpectedly, open a cmux terminal and type `tether folio` to reopen)
* in **Wave Terminal**, the Tether installation adds a sidebar widget labeled Tether Folio. Simply click it to open the folio in the focused workspace. Use `⌘-W` when focused to close it.

The folio is built to help you focus on active work, keep projects separate, and access docs and features with ease. Its main purpose is to **launch a document into the current workspace with a click**. It also includes tools to make your work smoother:

1. **Active** & **Archive** views

   * The top left button is the **Active** selector, which shows the number of active docs.
   * To its right is the **Archive**, where you can access archived docs just in case.
2. **Filters** & **Sorting**

   * The **Filter** (funnel) button opens the filter, allowing you to save custom searches. Type a word and press return to save it, then click the added pill button to toggle it on or off. Filters search against **file paths**, **file names**, and the **first H1 text within docs**.
   * The **Sorting** button lets you adjust the order and grouping of docs.
3. **Folio Menu** & **Right-Click Context Menu**

   * The top-right button in the folio allows for batch selection, importing, and app settings.
   * Right-click any document title in the folio to access quick actions for that document.

# pro(ductivity) tips

To get even more out of Tether:

1. **Use your agent's Global Context File for token management and tether-related behavior preferences**

   If your agent had to re-read the whole document each turn to see what you changed, it would use 100 times more tokens per session. Tether gives your agent a CLI tool to read just your annotations and edits without re-consuming the whole document.

   So, **make sure your agent has the CLI commands in its global context file** (i.e. AGENTS.md or CLAUDE.md) so it can efficiently use Tether. If it needs the instructions, tell it to run `tether setup --help`.
2. **Resolve finished threads & Archive old docs**

   To keep your own attention focused:

   * use the **Resolve** button to hide a finished comment thread. Resolved threads can still be found by using the "Show resolved" button in the Threads sidebar.
   * once you're done with a document, right-click it in the folio and choose **Archive** to get it out of your way.
3. Add a **filter** for each project

   Click the **Filter** (funnel) button in the folio, type the name of the project folder, and hit return to add its name as a toggleable filter. You can add subdirectories or specific titles to narrow your focus more.
4. Use **hotkeys** to work faster

   In **cmux**:

   * `⌘-B`\*\*\*\* to hide/show **left** sidebar (workspaces)
   * `⌘-⌥-B` to hide/show **right** sidebar (dock/folio)
   * `⌘-1`, `⌘-2`, etc. to choose a workspace
   * `⌘-⇧-↵` to make the current pane full-width (handy for focusing on a single document)
   * [More cmux hotkeys](https://cmux.com/docs/keyboard-shortcuts)

   In **Wave Terminal**:

   * `⌘-[` and `⌘-]` to cycle through tabs
   * `⌘-W`\*\*\*\* to close a block
   * [More Wave Terminal hotkeys](https://docs.waveterm.dev/keybindings)

