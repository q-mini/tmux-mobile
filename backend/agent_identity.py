"""Identify foreground CLI executables without returning process arguments."""
import json
from pathlib import Path
import sys


def identify(root, proc=Path('/proc')):
    def stat(pid):
        return (proc / str(pid) / 'stat').read_text().rsplit(') ', 1)[1].split()
    try:
        foreground = int(stat(root)[5])
        pending, seen, agents = [int(root)], set(), set()
        while pending and len(seen) < 256:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            try:
                status = stat(pid)
                pending.extend(map(int, (proc / str(pid) / 'task' / str(pid) / 'children').read_text().split()))
                if status[0] in {'T', 't', 'Z'} or (foreground > 0 and int(status[2]) != foreground):
                    continue
                args = (proc / str(pid) / 'cmdline').read_bytes().split(b'\0')[:3]
                names = [arg.decode(errors='replace') for arg in args]
                executable = Path(names[0]).name if names else ''
                script = next((name for name in names[1:] if not name.startswith('-')), '')
                if executable == 'claude':
                    agents.add('Claude')
                elif executable == 'codex' or (executable in {'node', 'nodejs'} and
                        (Path(script).name in {'codex', 'codex.js', 'codex.mjs'} or '/@openai/codex/' in script)):
                    agents.add('Codex')
            except (OSError, ValueError, IndexError):
                continue
        return next(iter(agents)) if len(agents) == 1 else None
    except (OSError, ValueError, IndexError):
        return None


if __name__ == '__main__':
    print(json.dumps(identify(int(sys.stdin.read()))))
