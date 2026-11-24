"""Launch only this app's jobs in one visible tmux window. Never replace a session."""
import argparse
import json
from pathlib import Path
import secrets
import shlex
import subprocess

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--local', action='store_true', help='Do not start a public tunnel')
parser.add_argument('--session', default='tmux-mobile')
args = parser.parse_args()
NAME = args.session
if not NAME or NAME.startswith('-') or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in NAME):
    parser.error('Session names may contain only letters, digits, - and _, and must not start with -.')

def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True).strip()

if subprocess.run(['tmux', 'has-session', '-t', '=' + NAME], capture_output=True).returncode == 0:
    raise SystemExit('Session already exists. Inspect with: tmux attach -t ' + NAME)
if not (ROOT / '.venv/bin/python').exists() or not args.local and not (ROOT / 'bin/cloudflared').exists():
    raise SystemExit('Install dependencies first: bash scripts/install.sh')
state = ROOT / '.state'
state.mkdir(mode=0o700, exist_ok=True)
owner = secrets.token_hex(16)
(state / 'tmux-owner').write_text(owner)
server = tmux('new-session', '-d', '-s', NAME, '-n', 'mobile', '-c', str(ROOT), '-P', '-F', '#{pane_id}', '/bin/bash', '--noprofile', '--norc', '-i')
tmux('set-option', '-t', NAME, '@tmux-mobile-owner', owner)
tmux('set-option', '-t', NAME, 'pane-border-status', 'top')
subprocess.run(['tmux', 'set-window-option', '-t', NAME + ':0', 'window-size', 'latest'], capture_output=True)
tmux('set-option', '-t', NAME, 'pane-border-format', '#{pane_index} #{pane_title}')
panes = {'server':server}
if not args.local:
    panes['tunnel'] = tmux('split-window', '-h', '-t', server, '-c', str(ROOT), '-P', '-F', '#{pane_id}', '/bin/bash', '--noprofile', '--norc', '-i')
panes['checks'] = tmux('split-window', '-v', '-t', server, '-c', str(ROOT), '-P', '-F', '#{pane_id}', '/bin/bash', '--noprofile', '--norc', '-i')
(state / 'panes.json').write_text(json.dumps(panes))
(state / 'service.json').write_text(json.dumps({'session':NAME,'owner':owner,'local':args.local}))
for job, pane in panes.items():
    tmux('select-pane', '-t', pane, '-T', job)
for job, command in [('server',['-m', 'backend']), ('tunnel',['scripts/tunnel.py'])]:
    if job not in panes:continue
    pane=panes[job]
    tmux('send-keys', '-t', pane, '-l', shlex.join(['bash', 'scripts/job.sh', job, '.venv/bin/python', '-u', *command]))
    tmux('send-keys', '-t', pane, 'Enter')
tmux('select-layout', '-t', NAME, 'tiled')
for job, pane in panes.items():
    print(job, pane, str(ROOT / 'logs' / (job + '.log')))
    print(tmux('capture-pane', '-pt', pane, '-S', '-5'))
print('tmux attach -t ' + NAME)
