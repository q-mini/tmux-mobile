"""tmux-mobile command: start or stop this installation and print its address and access key."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.state'


def read(name):
    try:
        return (STATE / name).read_text().strip()
    except OSError:
        return ''


def running():
    """The local origin when this installation's backend answers its health check."""
    origin = read('listen-url')
    if not origin:
        return ''
    try:
        with urllib.request.urlopen(origin + '/healthz', timeout=2) as response:
            return origin if json.load(response).get('app') == 'tmux-mobile' else ''
    except (OSError, ValueError):
        return ''


def service():
    try:
        return json.loads(read('service.json') or '{}')
    except ValueError:
        return {}


def show(origin, wait_public=False):
    details = service()
    public = '' if details.get('local') else read('public-url')
    if wait_public and not details.get('local'):
        # The tunnel writes its address a few seconds after it connects.
        for _ in range(120):
            public = read('public-url')
            if public:
                break
            time.sleep(.5)
    key = read('access-key')
    if details.get('session'):
        print('Session  tmux attach -t ' + details['session'])
    print('Local    ' + origin)
    if public:
        print('Phone    ' + public)
    elif wait_public and not details.get('local'):
        print('Phone    the tunnel has not reported an address yet; run tmux-mobile status again shortly')
    print('Key      ' + key)
    # The key travels in the fragment, which browsers never send to the server.
    print('Open     ' + (public or origin) + '/#key=' + key)
    return (public or origin) + '/#key=' + key


def start(args):
    origin = running()
    if origin:
        print('tmux-mobile is already running.')
        show(origin)
        return 0
    if not (ROOT / '.venv/bin/python').exists():
        print('Dependencies are missing. Run: python3 ' + str(ROOT / 'scripts/bootstrap.py') + (' --local' if args.local else ''), file=sys.stderr)
        return 1
    local = args.local or not (ROOT / 'bin/cloudflared').exists()
    if not local:
        (STATE / 'public-url').unlink(missing_ok=True)
    command = [sys.executable, str(ROOT / 'scripts/launch.py'), '--session', args.session] + (['--local'] if local else [])
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode:
        print((result.stderr or result.stdout).strip(), file=sys.stderr)
        return result.returncode
    for _ in range(90):
        origin = running()
        if origin:
            break
        time.sleep(.5)
    else:
        print('The server did not become healthy. Inspect it with: tmux attach -t ' + args.session, file=sys.stderr)
        return 1
    print('Started tmux-mobile' + (' (this computer only)' if local else ' with a public HTTPS address') + '.')
    link = show(origin, wait_public=not local)
    if os.environ.get('BROWSER'):
        # Editors such as VS Code set $BROWSER to open links on the user's own computer.
        try:
            subprocess.run([os.environ['BROWSER'], link], timeout=20, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            pass
    return 0


def main():
    parser = argparse.ArgumentParser(prog='tmux-mobile', description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    begin = commands.add_parser('start', help='Start the server if needed, then print the address and key')
    begin.add_argument('--local', action='store_true', help='Serve this computer only; no public tunnel')
    begin.add_argument('--session', default='tmux-mobile', help='tmux session that holds the service panes')
    commands.add_parser('stop', help='Stop the server and tunnel; other tmux sessions are untouched')
    commands.add_parser('status', help='Print the address and key if the server is running')
    commands.add_parser('key', help='Print the access key')
    commands.add_parser('url', help='Print a link that signs in with the key')
    args = parser.parse_args()
    if args.command == 'start':
        return start(args)
    if args.command == 'stop':
        return subprocess.run([sys.executable, str(ROOT / 'scripts/stop.py')], cwd=ROOT).returncode
    if args.command == 'key':
        key = read('access-key')
        print(key or 'No key yet. Run: tmux-mobile start')
        return 0 if key else 1
    origin = running()
    if not origin:
        print('tmux-mobile is not running. Start it with: tmux-mobile start', file=sys.stderr)
        return 1
    if args.command == 'url':
        print((origin if service().get('local') else read('public-url') or origin) + '/#key=' + read('access-key'))
        return 0
    show(origin)
    return 0


if __name__ == '__main__':
    sys.exit(main())
