"""Install this checkout and optionally start its visible, owned service panes."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def prerequisites():
    missing = [name for name in ['git', 'tmux', 'python3', 'npm', 'curl'] if not shutil.which(name)]
    if sys.version_info < (3, 11):
        missing.append('Python 3.11+')
    return missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Check prerequisites without installing or starting anything')
    parser.add_argument('--local', action='store_true', help='Skip downloading Cloudflare; serve loopback only')
    parser.add_argument('--start', action='store_true', help='Start the service in visible tmux panes after installation')
    parser.add_argument('--session', default='tmux-mobile', help='Owned service session name; never replaces an existing session')
    parser.add_argument('--agent', choices=['codex', 'claude'], help='Install this repository\'s skill for the selected agent')
    parser.add_argument('--skill-root', type=Path, help='Explicit skills directory for an isolated or custom agent installation')
    args = parser.parse_args()
    missing = prerequisites()
    if missing:
        parser.exit(1, 'Missing prerequisites: ' + ', '.join(missing) + '\nRead AGENT_SETUP.md; no system packages were changed.\n')
    print('PASS prerequisites: Python 3.11+, tmux, npm, curl and git', flush=True)
    if args.check:
        return
    import os
    environment = dict(os.environ)
    if args.local:
        environment['TMUX_MOBILE_SKIP_TUNNEL_INSTALL'] = '1'
    subprocess.run(['bash', str(ROOT / 'scripts/install.sh')], cwd=ROOT, env=environment, check=True)
    if args.agent:
        source = ROOT / 'skills/tmux-mobile'
        parent = args.skill_root or Path.home() / ('.codex/skills' if args.agent == 'codex' else '.claude/skills')
        target = parent / 'tmux-mobile'
        if target.exists():
            if (target / 'SKILL.md').read_bytes() != (source / 'SKILL.md').read_bytes():
                parser.exit(1, 'An existing tmux-mobile skill differs. Review it before replacing it: ' + str(target) + '\n')
        else:
            shutil.copytree(source, target)
        print('Agent skill ready: ' + str(target), flush=True)
    if args.start:
        command = [sys.executable, str(ROOT / 'scripts/launch.py'), '--session', args.session]
        if args.local:
            command.append('--local')
        subprocess.run(command, cwd=ROOT, check=True)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                origin = (ROOT / '.state/listen-url').read_text().strip()
                with urllib.request.urlopen(origin + '/healthz', timeout=2) as response:
                    if json.load(response).get('app') == 'tmux-mobile':
                        print('PASS application health. Local address: ' + origin, flush=True)
                        print('Login key is private: read .state/access-key locally; it is never printed by bootstrap.', flush=True)
                        print('Phone address, when ready: .state/public-url' if not args.local else 'Local-only mode; use an SSH forward or a trusted HTTPS reverse proxy for another device.', flush=True)
                        return
            except (OSError, ValueError):
                pass
            time.sleep(.25)
        parser.exit(1, 'Service did not become healthy. Inspect its tmux pane and logs/server.log.\n')


if __name__ == '__main__':
    main()
