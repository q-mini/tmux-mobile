"""Read installed CLI skill names/descriptions, locally or over authenticated SSH."""
import json
import hashlib
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import time


ANSI = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
UNTRUSTED = 'Folder is not trusted by the CLI'
MENU_ROW = re.compile(r'^\s*(?:[›❯>]\s*)?/([A-Za-z0-9][A-Za-z0-9_:.-]*)\s{2,}(\S.*)$')


def menu_rows(screen, prefix='/'):
    """Read complete native menu rows, retaining wrapped descriptions."""
    result = []
    for line in ANSI.sub('', screen).splitlines():
        match = (MENU_ROW.match(line) if prefix == '/' else
                 re.match(r'^\s*(?:[›❯>]\s*)?([A-Za-z0-9][A-Za-z0-9_:.-]*)\s{2,}\[Skill\]\s*(.*)$', line))
        if match:
            name, description = match.groups()
            result.append({'kind': 'command' if prefix == '/' else 'skill', 'name': name, 'insert': prefix + name,
                           'description': description.strip()})
        elif result and re.match(r'^\s{8,}\S', line) and not re.search(r'[›❯]|for shortcuts|for agents', line):
            result[-1]['description'] += ' ' + line.strip()
    return result


def native_commands(agent, cwd, home):
    """Inspect the installed TUI without typing into any user's pane or sending a turn.

    A private tmux socket supplies a real terminal. Only /, arrows, Escape and
    Ctrl-C are sent; no slash command is submitted. Cache belongs to the CLI
    installation and project, so remote hosts never borrow local command lists.
    """
    executable = shutil.which(agent.lower())
    if not executable:
        return [], 'CLI executable unavailable'
    executable = Path(executable).resolve()
    fingerprints = [(str(executable), executable.stat().st_mtime_ns)]
    if agent == 'Codex':
        for binary in executable.parent.parent.glob('node_modules/@openai/*/vendor/*/bin/codex'):
            fingerprints.append((str(binary), binary.stat().st_mtime_ns))
    for path in [home / '.codex/config.toml', home / '.claude/settings.json',
                 home / '.claude/plugins/installed_plugins.json', cwd / '.claude/settings.json']:
        if path.exists():
            fingerprints.append((str(path), path.stat().st_mtime_ns))
    for root in [home / '.codex/skills', home / '.agents/skills', home / '.claude/skills',
                 home / '.claude/commands', home / '.codex/plugins/cache',
                 *[p / '.agents/skills' for p in [cwd, *list(cwd.parents)[:8]]],
                 *[p / '.claude/skills' for p in [cwd, *list(cwd.parents)[:8]]]]:
        if root.exists():
            fingerprints.append((str(root), root.stat().st_mtime_ns))
            for path in root.glob('*/SKILL.md'):
                fingerprints.append((str(path), path.stat().st_mtime_ns))
    identity = hashlib.sha256(repr(('native-v4', agent, str(cwd), fingerprints)).encode()).hexdigest()[:24]
    cache = home / '.cache/tmux-mobile/menus' / (identity + '.json')
    try:
        value = json.loads(cache.read_text())
        if time.time() - value['captured'] < 3600 and value['items']:
            return value['items'], ''
    except (OSError, ValueError, KeyError, TypeError):
        pass
    socket = 'mobile-menu-' + secrets.token_hex(8)
    def tmux(*args, check=True):
        return subprocess.run(['tmux', '-L', socket, '-f', '/dev/null', *args], capture_output=True,
                              text=True, timeout=3, check=check).stdout
    found, error = {}, ''
    try:
        # This server is isolated from the app's user's tmux server.
        tmux('new-session', '-d', '-s', 'catalog', '-x', '200', '-y', '70', '-c', str(cwd),
             '/bin/bash', '--noprofile', '--norc', '-i')
        tmux('set-option', '-t', 'catalog', 'status', 'off')
        args = [str(executable)]
        if agent == 'Codex':
            args += ['--no-alt-screen']
        else:
            args += ['--settings', '{"disableAllHooks":true}', '--no-chrome']
        tmux('send-keys', '-t', 'catalog:0.0', '-l', 'exec ' + shlex.join(args))
        tmux('send-keys', '-t', 'catalog:0.0', 'Enter')
        deadline = time.monotonic() + 15
        screen = ''
        while time.monotonic() < deadline:
            screen = tmux('capture-pane', '-p', '-t', 'catalog:0.0')
            # Never answer the CLI's trust question on the user's behalf.
            if re.search(r'trust this|trust the files|Quick safety check', screen, re.I):
                return [], UNTRUSTED
            if re.search(r'^\s*[›❯]\s', screen, re.M):
                break
            time.sleep(.15)
        else:
            return [], 'Native CLI prompt unavailable'
        time.sleep(.3)
        for prefix in (['/', '$'] if agent == 'Codex' else ['/']):
            tmux('send-keys', '-t', 'catalog:0.0', '-l', prefix)
            unchanged, seen = 0, set()
            for step in range(140):
                time.sleep(.08 if step else .4)
                screen = tmux('capture-pane', '-p', '-t', 'catalog:0.0')
                if os.environ.get('TMUX_CATALOG_DEBUG'):
                    print('CATALOG STEP', prefix, step, repr(screen), file=sys.stderr, flush=True)
                rows = menu_rows(screen, prefix)
                before = len(seen)
                for item in rows:
                    found.setdefault(item['insert'], item)
                    seen.add(item['insert'])
                unchanged = unchanged + 1 if len(seen) == before else 0
                if unchanged >= (8 if seen else 20):
                    break
                tmux('send-keys', '-t', 'catalog:0.0', *(['Down'] * (5 if prefix == '/' else 3)))
            tmux('send-keys', '-t', 'catalog:0.0', 'Escape')
            time.sleep(.1)
            tmux('send-keys', '-t', 'catalog:0.0', 'BSpace')
            time.sleep(.1)
        if not found:
            error = 'Native CLI command menu unavailable'
        else:
            cache.parent.mkdir(parents=True, exist_ok=True)
            temporary = cache.with_suffix('.' + secrets.token_hex(4) + '.tmp')
            temporary.write_text(json.dumps({'captured': time.time(), 'items': list(found.values())}))
            temporary.replace(cache)
    except (OSError, subprocess.SubprocessError):
        error = 'Native CLI command menu unavailable'
    finally:
        # Never use the user's socket, pane IDs, session, input, or history.
        try:
            tmux('send-keys', '-t', 'catalog:0.0', 'Escape', 'C-u', 'C-c', 'C-c', check=False)
            time.sleep(.1)
            tmux('kill-server', check=False)
        except (OSError, subprocess.SubprocessError):
            pass
    return list(found.values()), error


def metadata(path):
    try:
        with path.open() as stream:
            text = stream.read(65536)
    except (OSError, UnicodeError):
        return {}
    if not text.startswith('---\n') or '\n---' not in text[4:]:
        return {}
    header = text[4:text.index('\n---', 4)]
    name = re.search(r'^name:\s*(.+?)\s*$', header, re.M)
    description = re.search(r'^description:\s*(.*)((?:\n[ \t]+[^\n]*)*)', header, re.M)
    result = {'name': name[1].strip('\"\'') if name else ''}
    invocable = re.search(r'^user-invocable:\s*(false|true)\s*$', header, re.M | re.I)
    if invocable:
        result['user-invocable'] = invocable[1].lower()
    if description:
        first = description[1].strip()
        result['description'] = (' '.join(description[2].split()) if first in {'>', '>-', '|', '|-'} else first.strip('\"\''))[:1500]
    return result


def project_entries(directory):
    """Names of project-level Claude skills and commands visible from a folder."""
    names = set()
    for folder in [directory, *list(directory.parents)[:8]]:
        names.update(path.parent.name for path in (folder / '.claude/skills').glob('*/SKILL.md'))
        commands = folder / '.claude/commands'
        names.update(':'.join(path.relative_to(commands).with_suffix('').parts) for path in commands.glob('**/*.md'))
    return names


def trusted_directory(home, cwd):
    """A folder Claude already trusts, used to read CLI-wide commands when cwd is not trusted."""
    try:
        projects = json.loads((home / '.claude.json').read_text()).get('projects', {})
    except (OSError, ValueError, AttributeError):
        return None
    folders = [Path(name) for name, value in projects.items()
               if isinstance(value, dict) and value.get('hasTrustDialogAccepted') and Path(name) != cwd and Path(name).is_dir()]
    # Folders without their own skills or commands add nothing project-specific to the menu.
    folders.sort(key=lambda folder: (any((folder / '.claude' / kind).exists() for kind in ('skills', 'commands')), len(folder.parts)))
    return folders[0] if folders else None


def catalog(agent, cwd, home=None, *, native=True):
    if agent not in {'Codex', 'Claude'}:
        return {'agent': None, 'items': []}
    home, cwd = Path(home or Path.home()), Path(cwd)
    roots = [home / ('.codex' if agent == 'Codex' else '.claude') / 'skills']
    if agent == 'Codex':
        roots.append(home / '.agents/skills')
    for directory in reversed([cwd, *list(cwd.parents)[:8]]):
        roots.append(directory / ('.agents' if agent == 'Codex' else '.claude') / 'skills')
        if agent == 'Codex':
            roots.append(directory / '.codex/skills')
    skills = {}
    for root in dict.fromkeys(roots):
        for path in [*root.glob('*/SKILL.md'), *root.glob('.system/*/SKILL.md')][:1000]:
            value = metadata(path)
            if value.get('user-invocable') == 'false':
                continue
            name = (value.get('name') or path.parent.name) if agent == 'Codex' else path.parent.name
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_:.\-]{0,119}', name):
                continue
            skills[name] = {'kind': 'skill', 'name': name, 'description': value.get('description', ''),
                            'insert': ('$' if agent == 'Codex' else '/') + name}
    if agent == 'Claude':
        for root in [home / '.claude/commands', *[p / '.claude/commands' for p in reversed([cwd, *list(cwd.parents)[:8]])]]:
            for path in list(root.glob('**/*.md'))[:1000]:
                name = ':'.join(path.relative_to(root).with_suffix('').parts)
                if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_:.\-]{0,119}', name):
                    skills[name] = {'kind': 'skill', 'name': name, 'description': metadata(path).get('description', ''), 'insert': '/' + name}
    # Installed plugin paths are resolved from the registry, never every cached
    # version. Project skills continue to take precedence over plugin entries.
    if agent == 'Claude':
        try:
            registry = json.loads((home / '.claude/plugins/installed_plugins.json').read_text()).get('plugins', {})
            enabled = json.loads((home / '.claude/settings.json').read_text()).get('enabledPlugins', {})
            for directory in reversed([cwd, *list(cwd.parents)[:8]]):
                for filename in ['settings.json', 'settings.local.json']:
                    try:
                        enabled.update(json.loads((directory / '.claude' / filename).read_text()).get('enabledPlugins', {}))
                    except (OSError, ValueError, AttributeError):
                        pass
            for plugin, entries in registry.items():
                if not enabled.get(plugin):
                    continue
                namespace = plugin.split('@')[0]
                for entry in entries:
                    if entry.get('projectPath') and Path(entry['projectPath']) != cwd:
                        continue
                    root = Path(entry['installPath'])
                    for path in [*(root / 'skills').glob('*/SKILL.md'), *(root / 'commands').glob('**/*.md')]:
                        value = metadata(path)
                        if value.get('user-invocable') == 'false':
                            continue
                        name = namespace + ':' + (value.get('name') or (path.parent.name if path.name == 'SKILL.md' else ':'.join(path.relative_to(root / 'commands').with_suffix('').parts)))
                        skills.setdefault(name, {'kind': 'skill', 'name': name, 'description': value.get('description', ''), 'insert': '/' + name})
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
    commands, error = native_commands(agent, cwd, home) if native else ([], '')
    fallback = trusted_directory(home, cwd) if error == UNTRUSTED and agent == 'Claude' else None
    if fallback:
        # Built-in, user and plugin commands are the same everywhere; drop the other folder's own entries.
        foreign = project_entries(fallback) - project_entries(cwd)
        commands, error = native_commands(agent, fallback, home)
        commands = [item for item in commands if item['name'] not in foreign]
    # Claude's native menu also supplies plugin/MCP commands. Mark known skills
    # as skills while retaining the native spelling and menu order.
    for item in commands:
        if item['name'] in skills and item['insert'] == skills[item['name']]['insert']:
            item['kind'] = 'skill'
            item['description'] = skills.pop(item['name'])['description'] or item['description']
    # Native popups bound their suggestions (especially the initial $ menu).
    # Include installed invocable skills beyond that first suggestion page.
    return {'agent': agent, 'items': [*commands, *sorted(skills.values(), key=lambda item: item['name'].lower())],
            'catalog_error': error}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    print(json.dumps(catalog(request.get('agent'), request['path']), ensure_ascii=False))
