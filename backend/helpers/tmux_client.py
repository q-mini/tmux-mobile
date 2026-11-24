"""Acquire a controlling PTY in a fresh process, then become the tmux client."""
import fcntl
import os
import shutil
import sys
import termios
from pathlib import Path

from ..hosts import load_hosts

slave = int(sys.argv[1])
target = sys.argv[2]
sizing = sys.argv[3] if len(sys.argv) > 3 else 'mirror'
os.setsid()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
for descriptor in [0, 1, 2]:
    os.dup2(slave, descriptor)
if slave > 2:
    os.close(slave)
os.environ['TERM'] = 'xterm-256color'
flags = ['-f', 'ignore-size'] if sizing == 'mirror' else []
command = ['tmux', '-u', 'attach-session', *flags, '-t', target]
if len(sys.argv) > 5:
    host = next(host for host in load_hosts(sys.argv[5]) if host.id == sys.argv[4])
    if not host.local:
        os.execv(shutil.which('ssh'), host.ssh(command, tty=True))
os.execv(shutil.which('tmux'), command)
