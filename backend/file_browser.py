"""One lazy cache per server/path, shared by every tmux pane and browser."""
import asyncio
import json
from collections import OrderedDict
from pathlib import Path
import sys
import time

from aiohttp import web

READER = Path(__file__).with_name('file_reader.py').read_text()
UPLOADER = Path(__file__).with_name('file_upload.py').read_text()


class FileBrowser:
    def __init__(self, workspace):
        self.workspace = workspace
        self.cache = OrderedDict()
        self.inflight = {}
        self.limits = {}
        self.cache_bytes = 0
        self.versions = {}

    async def close(self):
        jobs = list(self.inflight.values())
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)

    async def read(self, host_id, path='', mode='list', hidden=False, offset=0, refresh=False):
        host = self.workspace.hosts.get(host_id)
        if host is None:
            raise web.HTTPNotFound(text='설정된 서버를 선택해 주세요.')
        if mode not in {'list', 'preview', 'download', 'trash'}:
            raise web.HTTPBadRequest(text='파일 보기 요청을 확인해 주세요.')
        if not isinstance(path, str) or '\0' in path or len(path) > 4096:
            raise web.HTTPBadRequest(text='파일 경로를 확인해 주세요.')
        # Host identity includes the SSH endpoint/key so edits cannot reuse old data.
        key = (host, self.versions.get(host, 0), path, mode, bool(hidden), offset)
        cached = self.cache.get(key)
        if mode != 'download' and not refresh and cached and time.monotonic() - cached[0] < 5:
            self.cache.move_to_end(key)
            return cached[1]
        if key not in self.inflight:
            self.inflight[key] = asyncio.create_task(self._read(key))
        return await asyncio.shield(self.inflight[key])

    async def _read(self, key):
        host, version, path, mode, hidden, offset = key
        try:
            async with self.limits.setdefault(host, asyncio.Semaphore(2)):
                result = await self.execute(host, {'action': 'trash-list'} if mode == 'trash' else {'path': path, 'mode': mode, 'hidden': hidden, 'offset': offset})
            if mode != 'download':
                cost = len(json.dumps(result).encode())
                if cost <= 1024 * 1024:
                    previous = self.cache.pop(key, None)
                    if previous:
                        self.cache_bytes -= previous[2]
                    self.cache[key] = (time.monotonic(), result, cost)
                    self.cache_bytes += cost
                    while len(self.cache) > 128 or self.cache_bytes > 16 * 1024 * 1024:
                        self.cache_bytes -= self.cache.popitem(last=False)[1][2]
            return result
        finally:
            self.inflight.pop(key, None)

    async def mutate(self, host_id, options):
        host = self.workspace.hosts.get(host_id)
        if host is None:raise web.HTTPNotFound(text='설정된 서버를 선택해 주세요.')
        async with self.limits.setdefault(host, asyncio.Semaphore(2)):
            result = await self.execute(host, options)
        self.invalidate(host)
        return result

    def invalidate(self, host):
        self.versions[host] = self.versions.get(host, 0) + 1
        for key in list(self.cache):
            if key[0] == host:self.cache_bytes -= self.cache.pop(key)[2]

    async def upload(self, request):
        host = self.workspace.hosts.get(request.query.get('host'))
        if host is None:
            raise web.HTTPNotFound(text='설정된 서버를 선택해 주세요.')
        try:
            expected = int(request.query.get('size', ''))
            path = request.query.get('path', '')
            if not 0 <= expected <= 2**63-1 or len(path) > 4096 or '\0' in path:
                raise ValueError()
            reader = await request.multipart()
            part = await reader.next()
            if part is None or part.name != 'file' or part.filename is None:
                raise ValueError()
        except (ValueError, AssertionError):
            raise web.HTTPBadRequest(text='첨부할 파일과 폴더를 확인해 주세요.')
        argv = [sys.executable, '-c', UPLOADER] if host.local else host.ssh(['python3', '-c', UPLOADER])
        async with self.limits.setdefault(host, asyncio.Semaphore(2)):
            process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                async with asyncio.timeout(300):
                    try:
                        process.stdin.write(json.dumps({'path': path, 'name': part.filename, 'size': expected}).encode() + b'\n')
                        await process.stdin.drain()
                        received = 0
                        while chunk := await part.read_chunk(65536):
                            received += len(chunk)
                            if received > expected:
                                raise web.HTTPBadRequest(text='파일 크기가 달라 첨부를 취소했어요.')
                            process.stdin.write(chunk)
                            await process.stdin.drain()
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # Read the worker's precise conflict/permission error below.
                    finally:
                        process.stdin.close()
                    output, error = await process.communicate()
                if process.returncode:
                    raise web.HTTPServiceUnavailable(text='서버에 파일을 첨부하지 못했어요. 연결 상태를 확인해 주세요.')
                result = json.loads(output)
                if 'error' in result:
                    exception = {403: web.HTTPForbidden, 404: web.HTTPNotFound, 409: web.HTTPConflict}.get(result.get('status'), web.HTTPBadRequest)
                    raise exception(text=result['error'])
                self.invalidate(host)
                return result
            except (asyncio.TimeoutError, json.JSONDecodeError):
                raise web.HTTPServiceUnavailable(text='파일 전송이 지연되고 있어요. 연결 상태를 확인해 주세요.')
            finally:
                if process.returncode is None:
                    # SIGTERM lets the worker remove incomplete temporary files.
                    process.terminate()
                    try:
                        await asyncio.wait_for(process.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()

    async def execute(self, host, options):
        data = json.dumps(options).encode()
        argv, data = ([sys.executable, '-c', READER], data) if host.local else host.script(READER, data)
        process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            output, error = await asyncio.wait_for(process.communicate(data), timeout=60 if options.get('action') or options.get('mode') == 'download' else 15)
            if process.returncode:
                message = 'SSH 인증을 확인해 주세요.' if b'Permission denied' in error else '서버의 파일을 읽을 수 없어요. 연결 상태를 확인해 주세요.'
                raise web.HTTPServiceUnavailable(text=message)
            result = json.loads(output)
            if 'error' in result:
                status = result.get('status', 400)
                exception = {403: web.HTTPForbidden, 404: web.HTTPNotFound, 409: web.HTTPConflict}.get(status, web.HTTPBadRequest)
                raise exception(text=result['error'])
            return result
        except (asyncio.TimeoutError, json.JSONDecodeError):
            raise web.HTTPServiceUnavailable(text='파일 조회가 지연되고 있어요. 잠시 뒤 다시 열어 주세요.')
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
