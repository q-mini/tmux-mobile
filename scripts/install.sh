#!/usr/bin/env bash
set -euo pipefail
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11+ is required"'
for dependency in tmux npm curl; do
  command -v "$dependency" >/dev/null || { echo "Missing $dependency. Read AGENT_SETUP.md for system prerequisites." >&2; exit 1; }
done
set -x
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p web/vendor bin
cp node_modules/@xterm/xterm/lib/xterm.js web/vendor/xterm.js
cp node_modules/@xterm/xterm/css/xterm.css web/vendor/xterm.css
cp node_modules/@xterm/addon-fit/lib/addon-fit.js web/vendor/addon-fit.js
cp node_modules/@xterm/xterm/LICENSE web/vendor/LICENSE.xterm
cp node_modules/@xterm/addon-fit/LICENSE web/vendor/LICENSE.fit
# The tmux-mobile command goes into a user-owned folder; an unrelated file there is never replaced.
bin_dir=${TMUX_MOBILE_BIN_DIR:-$HOME/.local/bin}
mkdir -p "$bin_dir"
if [[ -e "$bin_dir/tmux-mobile" && "$(readlink -f "$bin_dir/tmux-mobile")" != "$PWD/scripts/tmux-mobile" ]]; then
  echo "Kept the existing $bin_dir/tmux-mobile; run $PWD/scripts/tmux-mobile instead."
else
  ln -sfn "$PWD/scripts/tmux-mobile" "$bin_dir/tmux-mobile"
  case ":$PATH:" in *":$bin_dir:"*) ;; *) echo "Add $bin_dir to PATH to use the tmux-mobile command.";; esac
fi
if [[ "${TMUX_MOBILE_SKIP_TUNNEL_INSTALL:-0}" == 1 ]]; then
  echo 'Local-only installation complete; Cloudflare download skipped.'
  exit 0
fi
if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
  echo 'Automatic Cloudflare download supports Linux x86_64. Install cloudflared for your platform, or use --local.' >&2
  exit 1
fi
curl --fail --location --retry 2 --connect-timeout 10 --max-time 180 --output bin/cloudflared https://github.com/cloudflare/cloudflared/releases/download/2026.10.6/cloudflared-linux-amd64
printf '%s  %s\n' 1d356dac769d0dbf62ebe588c4034824bbff98d5790c2f844cc99e0e2f57462d bin/cloudflared | sha256sum -c
chmod 755 bin/cloudflared
bin/cloudflared --version
