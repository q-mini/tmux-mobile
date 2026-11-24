"""Capture the real GUI with disposable demo data and an isolated tmux server.

No live server inventory, agent transcript, login key, or SSH account is read.
The guide's agent replies/catalogs are synthetic; this never calls an LLM.
"""
import asyncio
import base64
import io
import getpass
import json
import os
from pathlib import Path
import secrets
import socket
import shlex
import shutil
import sys
import tempfile
import time

from aiohttp import web
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend import file_browser
from backend.fleet import FleetWorkspace
from backend.hosts import Host
from backend.server import make_app, Settings, WORKSPACE, FILES, ATTACHMENTS, NOTIFICATIONS, SSH_SETUP
sys.path.insert(0, str(ROOT/'scripts'))
from guide_documents import hwp_document, slide_deck


class GuideFleet(FleetWorkspace):
    def __init__(self, home, terminal, tmux):
        super().__init__([Host('local', 'Local', user='demo', local=True)], set())
        self.home, self.terminal_script, self.tmux = home, terminal, tmux
        self.messages, self.model_open = {}, set()

    def pane_info(self, host, pane):
        return {**super().pane_info(host, pane), 'title': 'Demo terminal'}

    async def sessions(self, fresh=False):
        self.last['local'] = await self.backends['local'].sessions(fresh=fresh)
        self.statuses['local'] = '연결됨'
        for host in self.hosts.values():
            if not host.local:
                self.statuses[host.id] = 'SSH 로그인 설정 필요'
                self.last[host.id] = []
        return [self.session_info(self.local, session) for session in self.last['local']]

    async def create_session(self, host_id, name, path=''):
        if host_id != 'local':
            raise web.HTTPConflict(text='The guide does not connect to external SSH servers.')
        result = await super().create_session(host_id, name, path)
        pane = result['panes'][0]['id']
        process = await asyncio.create_subprocess_exec(self.tmux, 'send-keys', '-t', pane, '-l', shlex.join([sys.executable, '-u', str(self.terminal_script)]))
        await process.wait()
        process = await asyncio.create_subprocess_exec(self.tmux, 'send-keys', '-t', pane, 'Enter')
        await process.wait()
        await asyncio.sleep(.4)
        process = await asyncio.create_subprocess_exec(self.tmux, 'clear-history', '-t', pane)
        await process.wait()
        for command in [('select-pane','-t',pane,'-T','Demo terminal'),('set-option','-g','status-right','Demo server'),('set-option','-g','pane-border-status','top')]:
            process=await asyncio.create_subprocess_exec(self.tmux,*command);await process.wait()
        return result

    async def conversation(self, pid, before='', known=''):
        source = 'claude' if int(pid.lstrip('%')) % 2 else 'codex'
        version = str(len(self.messages.get(pid, [])))
        messages = [
            {'id': pid+'-u1', 'role': 'user', 'text': 'Review the demo project and summarize the results in a table.'},
            {'id': pid+'-a1', 'role': 'assistant', 'text': 'I checked the sample project.\n\n| Item | Status |\n|---|---|\n| Code review | Complete |\n| Tests | 12 passed |\n| Report | results/report.md |\n\n```python\nfrom pathlib import Path\n\ndef summarize(values):\n    # Keep the original input unchanged.\n    return {"count": len(values), "total": sum(values)}\n```\n\nAll conversations, projects and server details shown here are fictional guide data.'},
            {'id': pid+'-t1', 'role': 'tool', 'text': '$ python -m unittest\n............\nRan 12 tests\nOK'},
        ] + self.messages.get(pid, [])
        return {'source': source, 'session_id': '00000000-0000-4000-8000-000000000001', 'version': version,
                'changed': known != version, 'changed_at': 1800000000, 'before': '', 'has_more': False,
                'status_lines': [source.title()+' · Demo model · Context 76% remaining'],
                'messages': messages}

    async def agent_state(self, pid):
        return {'agent': 'claude' if int(pid.lstrip('%')) % 2 else 'codex', 'modes': [], 'account': {'supported': False}}

    async def catalog(self, pid):
        agent = 'Claude' if int(pid.lstrip('%')) % 2 else 'Codex'
        return {'agent': agent, 'model_ready': True, 'command_token': 'd'*32, 'items': [
            {'name': 'help', 'insert': '/help', 'kind': 'command', 'description': 'Show available commands'},
            {'name': 'model', 'insert': '/model', 'kind': 'command', 'description': 'Choose a model for the connected agent'},
            {'name': 'review', 'insert': '/review', 'kind': 'command', 'description': 'Review the current work'},
            {'name': 'tmux-mobile', 'insert': ('/' if agent == 'Claude' else '$')+'tmux-mobile', 'kind': 'skill', 'description': 'Install and operate tmux mobile'},
        ]}

    async def interaction(self, pid, **options):
        if pid not in self.model_open:
            return None
        return {'kind': 'single', 'purpose': 'model', 'title': 'Choose a model (guide demonstration)', 'tabs': '',
                'progress': '', 'selected': 0, 'text': 'Model choices come from your connected CLI.', 'token': 'd'*32,
                'options': [{'number': 1, 'label': 'Default model', 'description': 'Demo option · current model'},
                            {'number': 2, 'label': 'Fast model', 'description': 'Demo option · lower latency'}]}

    async def pending_input(self, pid):
        return None

    async def send(self, pid, payload, owner):
        if payload.get('type') == 'agent_command':
            self.model_open.add(pid)
        elif payload.get('type') == 'interaction':
            self.model_open.discard(pid)
        elif payload.get('type') == 'text':
            messages = self.messages.setdefault(pid, [])
            messages.extend([{'id': pid+'-user-'+str(len(messages)), 'role': 'user', 'text': payload.get('text', '')},
                             {'id': pid+'-reply-'+str(len(messages)), 'role': 'assistant', 'text': 'Demo input received. Attachments and text are delivered to the selected pane.'}])
        return {'ok': True, 'pane_id': pid}


async def main():
    if not shutil.which('tmux'):
        raise SystemExit('tmux is required for isolated guide captures.')
    with tempfile.TemporaryDirectory(prefix='tmux-mobile-guide-') as temporary:
        directory = Path(temporary)
        home = directory/'demo-home';home.mkdir()
        project = directory/'demo-project';(project/'src').mkdir(parents=True);(project/'results').mkdir()
        (project/'src/main.py').write_text('from pathlib import Path\n\ndef summarize(values):\n    # A fictional project for the installation guide.\n    return {"count": len(values), "total": sum(values)}\n\nprint(summarize([2, 4, 6]))\n')
        (project/'README.md').write_text('# Demo project\n\nDocumentation-only sample files.\n')
        (project/'results/report.md').write_text('# Test results\n\n| Check | Result |\n|---|---|\n| Input validation | Pass |\n| Unit tests | 12 passed |\n')
        image = Image.new('RGB', (640, 320), '#15191e');draw=ImageDraw.Draw(image)
        draw.text((24, 20), 'Demo results', fill='#c7d5e5')
        for index, value in enumerate([100, 170, 135, 220]):
            draw.rectangle((60+index*130, 290-value, 130+index*130, 290), fill='#91b5d9')
        image.save(project/'results/chart.png')
        slide_deck(project/'results/weekly.pptx', [
            {'title': 'Weekly results', 'bullets': ['Placement finished on both dies', 'Routing congestion dropped by 8%', 'Worst slack improved to -12 ps'],
             'table': [['Metric', 'Before', 'Now'], ['WNS (ps)', '-27.9', '-12.0'], ['Area (um2)', '1520', '1498']], 'picture': True},
            {'title': 'Next steps', 'bullets': ['Shrink the hybrid bonding pitch', 'Repeat timing with the new clock tree']}],
            picture=(project/'results/chart.png').read_bytes())
        (project/'results/report.hwp').write_bytes(hwp_document([
            'Weekly experiment report', 'This fictional Hangul document compares two placement runs.',
            [['Metric', 'Before', 'Now'], ['WNS (ps)', '-27.9', '-12.0'], ['Area (um2)', '1520', '1498']],
            'Next week the bonding pitch is reduced and timing is measured again.']))
        terminal = directory/'terminal.py'
        terminal.write_text('import sys\nprint("\\033[2J\\033[H\\033[38;2;145;181;217mDemo terminal\\033[0m\\nDocumentation sandbox · no user session is attached.\\n\\n$ python -m unittest\\n............\\n\\033[32m12 tests passed\\033[0m\\n\\nPress keys or type a message in the input below.",flush=True)\ntry:\n for line in sys.stdin: print("demo> "+line.rstrip(),flush=True)\nexcept KeyboardInterrupt: pass\n')
        tools = directory/'tools';tools.mkdir()
        tmux_socket = 'tmux-mobile-guide-'+secrets.token_hex(6)
        real_tmux = shutil.which('tmux')
        wrapper = tools/'tmux';wrapper.write_text('#!/bin/sh\nexec '+shlex.quote(real_tmux)+' -L '+shlex.quote(tmux_socket)+' "$@"\n');wrapper.chmod(0o755)
        previous_path = os.environ.get('PATH', '')
        os.environ['PATH'] = str(tools)+os.pathsep+previous_path
        state = directory/'state';state.mkdir()
        (state/'hosts.json').write_text(json.dumps({'hosts':[{'id':'local','name':'Local','local':True,'user':'demo'}]}))
        # Only worker subprocesses get this demo home. The agent's HOME is untouched.
        original_reader = file_browser.READER
        file_browser.READER = original_reader.replace('Path.home()', 'Path('+repr(str(home))+')').replace("__import__('socket').gethostname()", "'demo-host'")
        settings = Settings(state=state, key=secrets.token_urlsafe(32), accounts_path=state/'accounts.sqlite3', watch_questions=False)
        app = make_app(settings)
        fleet = GuideFleet(home, terminal, str(wrapper));app[WORKSPACE]=fleet
        app[FILES].workspace=fleet;app[ATTACHMENTS].workspace=fleet;app[NOTIFICATIONS].fleet=fleet;app[SSH_SETUP].fleet=fleet
        async def demo_probe(host):
            return {'token':'documentation-only-token','fingerprints':['Documentation-only fingerprint; verify your real server before connecting.']}
        app[SSH_SETUP].probe=demo_probe
        async def guide(request):
            data = await request.json()
            if data.get('action') == 'notifications':
                sessions = await fleet.sessions();session=sessions[0];pane=session['panes'][0]
                app[NOTIFICATIONS].items=[{'id':'a'*24,'created_at':time.time(),'read':False,'host':'local','host_name':'Local',
                    'session_id':session['id'],'session_name':session['name'],'pane_id':pane['id'],'pane_title':'Demo agent',
                    'agent':'Codex','kind':'single','title':'Save the report?','body':'This is a demo question. Reply in the selected pane.','choices':['Save','Continue reviewing']}]
                app[NOTIFICATIONS].save()
            return web.json_response({'ok':True,'project':str(project)})
        app.router.add_post('/guide', guide)
        runner = web.AppRunner(app);await runner.setup();site=web.TCPSite(runner,'127.0.0.1',0);await site.start()
        origin='http://127.0.0.1:'+str(site._server.sockets[0].getsockname()[1]);settings.local_origins.add(origin)
        print('Guide uses loopback, a new account DB, fictional agent replies and isolated tmux. No real SSH or LLM calls.',flush=True)
        try:
            video_dir=directory/'recording';video_dir.mkdir()
            environment=dict(os.environ,GUIDE_VIDEO_DIR=str(video_dir),GUIDE_ORIGIN=origin,GUIDE_KEY=settings.key,GUIDE_PROJECT=str(project),
                             GUIDE_PRIVATE_MARKERS=json.dumps([getpass.getuser(),socket.gethostname(),str(Path.home())]))
            node=shutil.which('node')
            process=await asyncio.create_subprocess_exec(node,str(ROOT/'scripts/capture_guide.cjs'),env=environment)
            status=await process.wait()
            if status==0:
                builder=await asyncio.create_subprocess_exec(sys.executable,'-u',str(ROOT/'scripts/build_guide_gif.py'),str(video_dir/'timeline.json'))
                status=await builder.wait()
            return status
        finally:
            await runner.cleanup();file_browser.READER=original_reader
            # These are only the receiver processes created by this guide's socket.
            process=await asyncio.create_subprocess_exec(str(wrapper),'list-panes','-a','-F','#{pane_id}',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
            output,_=await process.communicate()
            for pane in output.decode().splitlines():
                child=await asyncio.create_subprocess_exec(str(wrapper),'send-keys','-t',pane,'C-c');await child.wait()
            await asyncio.sleep(.3)
            child=await asyncio.create_subprocess_exec(str(wrapper),'list-panes','-a','-F','#{pane_pid}',stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
            shells,_=await child.communicate()
            for pid in shells.decode().splitlines():
                child=await asyncio.create_subprocess_exec('ps','--ppid',pid,'-o','pid=,comm=',stdout=asyncio.subprocess.PIPE)
                running,_=await child.communicate()
                if running.strip():raise RuntimeError('Guide receiver is still running; its isolated tmux server is preserved.')
            child=await asyncio.create_subprocess_exec(str(wrapper),'kill-server',stderr=asyncio.subprocess.DEVNULL);await child.wait()
            os.environ['PATH']=previous_path
            print('Disposable guide processes, account DB, SSH configuration and file uploads removed.',flush=True)


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
