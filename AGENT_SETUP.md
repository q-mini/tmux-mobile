# Set up tmux mobile (instructions for a coding agent)

The user gave you this file because they want tmux mobile running on this machine. Work through the steps in order. Stop and ask only where a step says so.

Scope: install and start this app. Don't install an AI provider, change unrelated agent settings, or import servers or accounts from another installation.

## 1. Look before installing

- If `tmux-mobile status` prints addresses, the app is already installed and running. Go to step 6.
- If a checkout already exists (a folder with `scripts/bootstrap.py`), `cd` into it and skip the clone in step 3.
- If a tmux session named `tmux-mobile` exists but `tmux-mobile status` fails, show the user `tmux attach -t tmux-mobile` and ask before touching it. Never kill or replace tmux sessions you did not create.

## 2. Make sure the tools exist

The server needs Linux (a VM or WSL works), Python 3.11+, tmux (3.2+ for full terminal sizing), Node.js with npm, git and curl.

```bash
python3 --version; tmux -V; node --version; npm --version; git --version; curl --version
```

If everything is there, go to step 3. Otherwise pick one of these:

**With sudo.** Use it if `sudo -n true` succeeds, or if the user agrees to type their password into the terminal themselves. Never ask for a password in chat.

```bash
sudo apt-get update
sudo apt-get install -y git tmux python3 python3-venv python3-pip nodejs npm curl
```

Use the machine's own package manager if it isn't Debian or Ubuntu.

**Without sudo.** Install the tools into the user's home folder with micromamba. If tmux is already installed system-wide, remove `tmux` from the package list so the user keeps one tmux server.

```bash
mkdir -p ~/.local/bin
curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xj -C ~/.local bin/micromamba
~/.local/bin/micromamba create -y -p ~/.local/tmux-mobile-env -c conda-forge python=3.12 tmux nodejs git curl
echo 'export PATH="$HOME/.local/tmux-mobile-env/bin:$HOME/.local/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/tmux-mobile-env/bin:$HOME/.local/bin:$PATH"
```

Run the version check again before continuing.

## 3. Get the code

```bash
git clone https://github.com/q-mini/tmux-mobile.git
cd tmux-mobile
```

## 4. Install

Use the public mode unless the user said the app should stay on this computer:

```bash
python3 scripts/bootstrap.py           # phone access through a Cloudflare Quick Tunnel (Linux x86_64)
python3 scripts/bootstrap.py --local   # this computer only
```

This creates `.venv`, installs npm packages, downloads a pinned, checksum-checked Cloudflare client in public mode, and links the `tmux-mobile` command into `~/.local/bin`. It takes a minute or two. If your environment expects long jobs in a visible tmux pane, run it there and keep its output and exit status.

## 5. Start

```bash
tmux-mobile start            # or: tmux-mobile start --local
```

If the shell says `tmux-mobile: command not found`, `~/.local/bin` is not on `PATH`. Run `./scripts/tmux-mobile start` instead and tell the user to add `export PATH="$HOME/.local/bin:$PATH"` to `~/.bashrc`.

`start` runs the server in a tmux session named `tmux-mobile`, waits until it answers, and prints the local address, the phone address (public mode), the access key and a sign-in link. Leave this service running when you finish.

To check that it works, run `tmux-mobile status`. A fresh install shows only the **Local** server and possibly no tmux sessions; that is normal.

## 6. Tell the user

Report, in this order:

1. The phone address (`Phone` line) and the local address (`Local` line).
2. "Run `tmux-mobile url` in your terminal and open that link on your phone. It signs you in without typing the key."
3. `tmux attach -t tmux-mobile` shows the service; `tmux-mobile stop` stops it; `tmux-mobile start` brings it back. The phone address changes when the tunnel restarts.

The key and the sign-in link give terminal access to this machine. Don't copy them into chat messages, files, commits, issues or any external service; the user reads them from their own terminal. Passwords, recovery codes, cookies and SSH keys are never printed or stored either.

## 7. Optional, only if the user asks

- **More servers:** in the web app, use **Add server**, then let the user type the server password into that form, not into chat ([steps](docs/gui-guide.md#18-connect-another-server)). Remote servers need SSH, Python 3 and tmux. A form opening is not a connection; confirm that the server's sessions appear.
- **An account instead of the key:** after signing in, **Settings → Create account**. Passwords need at least 10 characters with a letter, a digit and punctuation. The recovery code stays with the user.
- **This file as a reusable skill:** `python3 scripts/bootstrap.py --agent claude` (or `--agent codex`) copies `skills/tmux-mobile` into the agent's skill folder. An existing, different skill is left alone.

Never commit `.state/`, `logs/`, real server settings, databases, SSH keys, attachments or conversations.
