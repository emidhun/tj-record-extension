# Set up TJ Record for your AI agent

Paste the prompt below into Claude Code, Codex or another coding agent. It installs the recorder,
connects the agent to the recorder's browser, checks a test recording works, and saves the
recording instructions so you can later just say *"record this with TJ Record"*.

You also need the TJ Record extension in your own browser, where you upload recordings:
install it from the Chrome Web Store (link in the [README](README.md#install)).

```
Set up TJ Record agent recording on this machine, so you can record browser sessions for me.

1. Get the recorder. If ~/tj-record-extension doesn't exist, run
   git clone https://github.com/emidhun/tj-record-extension ~/tj-record-extension
   otherwise run: git -C ~/tj-record-extension pull
   Then in ~/tj-record-extension run: npm install && npm run setup
   (needs Node 20 or later; `npm run setup` downloads Chrome for Testing).

2. Add an MCP server named "tj-record-browser" for yourself, so you can drive the recorder's browser.
   Skip this if you already have one with that name.
   - Claude Code:
     claude mcp add --scope user tj-record-browser -- npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --no-usage-statistics
   - Codex: append to ~/.codex/config.toml
     [mcp_servers.tj-record-browser]
     command = "npx"
     args = ["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222", "--no-usage-statistics"]
   - Any other agent: add an MCP server that runs
     npx -y chrome-devtools-mcp@latest --browserUrl http://127.0.0.1:9222 --no-usage-statistics

3. Check that recording works. In ~/tj-record-extension run
   npm run agent -- https://example.com --headless --cdp-port 0
   in the background and wait for its "ready" line. After 3 seconds run
   curl -X POST localhost:47900/stop
   then
   curl -X POST localhost:47900/quit
   The stop response must list video.webm and an uploadLink. Delete the folder it names (the test
   recording). If something fails, show me the error.

4. Save the instructions below in your global instructions file under a "TJ Record" heading
   (Claude Code: ~/.claude/CLAUDE.md, Codex: ~/.codex/AGENTS.md, other agents: their equivalent),
   so you can follow them in later sessions:

   When I ask you to record a browser session with TJ Record:
   - In ~/tj-record-extension run `npm run agent -- <url>` in the background (add `--replay` for long
     tasks: instant replay keeps the last 3 minutes) and wait for its "ready" line. If port 47900 is
     busy, a recorder is already running: check `curl localhost:47900/status`.
   - Do the task in that browser with the tj-record-browser MCP tools. Don't click TJ Record's own
     Stop or Discard buttons on the page, and don't sign in to personal accounts there.
   - To finish, run `curl -X POST localhost:47900/stop` (recording, 3 minutes max) or
     `curl -X POST 'localhost:47900/save?ms=180000'` (instant replay). Give me the uploadLink, the
     folder and the error counts from the response. I open the link in my own browser to upload.
   - Keep the recorder running until I say I've uploaded (the link needs it), then run
     `curl -X POST localhost:47900/quit`. For an older recording, `npm run agent -- --serve` makes
     its link work again.

5. Tell me when it's done. Remind me to restart you so the new MCP server loads, and to install the
   TJ Record extension in my own browser if I haven't.
```

After you restart the agent, try it: *"Record https://todomvc.com/examples/react/dist/ with TJ
Record: add three todos and complete one, then give me the upload link."*

Details of each step: [Recording from AI agents](README.md#recording-from-ai-agents-claude-code-codex-).
