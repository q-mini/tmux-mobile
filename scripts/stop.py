"""Stop this app and its public tunnel, preserving all tmux sessions."""
import os
from pathlib import Path
import signal
import time

ROOT = Path(__file__).resolve().parent.parent
for job, script in [('tunnel','scripts/tunnel.py'), ('server','backend')]:
    try:
        pid = int((ROOT / '.state' / (job + '.pid')).read_text())
        command = Path('/proc',str(pid),'cmdline').read_bytes().split(b'\0')
        cwd = Path('/proc',str(pid),'cwd').resolve()
        if cwd != ROOT or not any(value.decode(errors='replace') in {script,str(ROOT / script)} for value in command):
            raise SystemExit('Refusing to stop an unrelated process: ' + job)
        os.kill(pid,signal.SIGTERM)
        for _ in range(60):
            if not Path('/proc',str(pid)).exists():
                break
            time.sleep(0.1)
        print(job, 'stop requested; check its tmux pane for exit status')
    except (FileNotFoundError, ProcessLookupError):
        print(job, 'is not running')
