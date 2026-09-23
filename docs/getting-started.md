![1.00](assets/tether-banner.png)

# getting started with **tether**

Tether turns Markdown files into a conversation surface, keeping your attention clear and focused in long AI-driven projects. Here's how use it:

1. **Leave a comment.** Highlight any sentence of this document, choose **Comment** (the rightmost button in the tooltip menu), and ask your agent a question or give an instruction.

   * You can leave dozens of comments on the same doc before the next turn. Your agent gets them all, each with context, using Tether's CLI tool.
   * Each comment starts a **thread**, helping you keep track of the many subtasks a single doc can produce.
   * The **Threads drawer**, opened via the top-right button in this window, shows all the open threads on a doc.

2. **Prompt your agent.** Tether is designed to collect your comments without activating an agent turn on every one. Once you want your agent to respond, say something like:

   > review tether comments on `{{DOCUMENT_PATH}}`

   (To get the file path to a doc, open the Threads drawer and click the "Copy file path" button. If your agent already has the doc in context, no need to give it the path.)

3. **Continue the thread(s).** Your agent will use context clues for each thread:
   * If a comment needs a response, your agent will reply in the thread; a notification badge will appear on the threads button.
   * If a comment requires revision, your agent will edit the document text itself. (This may "orphan" the comment if its highlighted text changes, but the thread will still be visible in the threads drawer)
   * If a comment raises a broader issue, your agent will reply inline in the conversation.

Your Markdown stays in its original file. Comments are kept separate as private local data and aren't included when you share the file. Use **Export with annotations** to share open threads in a `.tether` package, and **Import annotations** (found in the folio) to add a `.tether` package from elsewhere.

# using the **folio**

Tether comes with an organizer called **folio**. The folio is built to help you focus on active work, keep projects separate, and access docs and features with ease. Its main purpose is to **launch a document into the current workspace with a click**. To access the folio:

* in **cmux**, use the hotkey `⌘-⌥-B` to hide/show folio. (The first time you use it, you may have to enable the **dock** in **settings > beta features > dock**, then navigate to **dock > Tether Folio**. If the folio tab gets closed or quits unexpectedly, open a cmux terminal and type `tether folio` to reopen)
* in **Wave Terminal**, the Tether installation adds a Tether Folio sidebar widget. Simply click it to open the folio in the focused workspace. Use `⌘-W` when focused to close it.

&#x20;The folio includes these tools to make your work smoother:

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

1. **Make sure the tether-review skill is installed**

   ...or that your agent has Tether-related instructions in its global context file. Installing the skill is best since Tether's updates keep it working with future changes, even while preserving your customizations. To install, copy the prompt below and paste it to your agent:

   ```
   Install Tether’s bundled tether-review skill for this agent. Run `tether setup --help`, find your skills directory, then use `tether setup --agent-directory <skills-directory> --no-open` under the same OS account and Tether profile as this guide. This installs the skill and registers it for package updates. If existing instructions differ, preserve them and help me review the differences before replacing them.
   ```
2. **Resolve finished threads & Archive old docs**

   To keep your own attention focused:

   * use the **Resolve** button to hide finished comment threads.
   * once you're done with a document, right-click it in the folio and choose **Archive**.
3. Add a **filter** for each project:

   Click the **Filter** (funnel) button in the folio, type the name of the project folder, and hit return to add its name as a toggleable filter. You can add subdirectories or specific titles to narrow your focus more.
4. Use **hotkeys** to work faster in **cmux**:

   * `⌘-B` to hide/show **left** sidebar (workspaces)
   * `⌘-⌥-B` to hide/show **right** sidebar (dock/folio)
   * `⌘-1`, `⌘-2`, etc. to choose a workspace
   * `⌘-⇧-↵` to make the current pane full-width
   * [More cmux hotkeys](https://cmux.com/docs/keyboard-shortcuts)

