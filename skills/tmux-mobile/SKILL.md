---
name: tmux-mobile
description: Install, configure, operate, or repair the tmux-mobile web app for phone and desktop access to tmux sessions. Use for this application, not unrelated tmux or terminal tasks.
---

# tmux mobile

Locate the application checkout containing `backend/`, `web/` and `scripts/`. Read its README and applicable AGENTS.md before changes. Resolve every project path from that checkout; do not assume an account name, home directory, internal host, existing pane ID, or public URL.

For a clean-machine installation, read `AGENT_SETUP.md` from that checkout. If no checkout exists, clone `https://github.com/q-mini/tmux-mobile.git`. Install with `python3 scripts/bootstrap.py` (add `--local` to skip the phone tunnel), then start with `tmux-mobile start` (or `--local`); `--session my-mobile` selects a different service session. If `tmux-mobile status` already prints addresses, the service is healthy and needs no second start. Report the local and phone addresses and point the user to `tmux-mobile url` for the sign-in link; never copy the key or link into chat, source control, browser storage, command arguments or logs.

Remote hosts are added with **Add server** in the app and saved in `.state/hosts.json`. Never ship real server addresses, account names, key files, passwords, session inventories, transcripts, attachments or deployment state. Connection status must reflect authenticated SSH access. Keep per-server tmux IDs qualified and route all input to the selected pane.

Inspect existing process and session ownership before restarting. Run service and verification jobs visibly in task-owned tmux panes, with command output, logs and exit status. Keep foreground jobs and preserve unrelated sessions and running work. When a task's finite jobs finish, check descendants before closing only its completed sessions. A deliberately running application service remains running until asked to stop.

Use proportional checks: synthetic unit tests for backend input and routing; a real browser for display and interaction changes. Send test input only to a newly created task-owned fixture pane. Inspect real user output read-only; never resize or type into a user's active pane during reader validation. Desktop original-terminal sizing must be checked in the browser against both available dimensions. Phones and dedicated viewers must retain source sizing.

Message mode preserves pane-specific drafts and Korean composition. Direct mode sends immediate literal bytes and control sequences through the pane input endpoint, without an implicit Enter or message paste. Preserve ordering and stop on failed delivery rather than replaying keys. Session creation opens a shell on a configured host and must not replace an existing session. Code blocks preserve source rows and indentation; prose reflows, and tables preserve their columns and source ANSI styling.

When publishing a source copy, keep `.state/`, logs, histories, SSH keys, local dependencies, generated artifacts and personal deployment scripts out of the tree. Check file contents and git author metadata as well as ignore rules. Follow the user's visibility request; uploading this skill never authorizes a public repository.

The illustrated user workflow is in the checkout's `docs/gui-guide.md`. Rebuild the guide clips with `make screenshots` after installing Playwright Chromium; it uses an isolated tmux socket, fresh credentials and fictional data, never the user's app. Keep its existing remote/visibility and push only the intended, reviewed source and documentation.
