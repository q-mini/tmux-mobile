"""Private file uploads, routed to the same host as the selected tmux pane."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import time

from aiohttp import web
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_FILE_SIZE = 50 * 1024 * 1024
MAX_ATTACHMENTS = 5
UNSENT_TTL = 3600
SENT_TTL = 24 * 3600
REMOTE_DELETE = r'''
import pathlib,re,shutil,sys
ident=sys.argv[1]
if not re.fullmatch('[a-f0-9]{32}',ident): raise ValueError('invalid attachment')
folder=pathlib.Path.home()/'.local/share/tmux-mobile/attachments'/ident
if folder.is_symlink(): raise ValueError('invalid attachment folder')
if folder.exists(): shutil.rmtree(folder)
'''
REMOTE_SAVE = r'''
import hashlib,json,os,pathlib,sys
ident,name,expected,digest=sys.argv[1:]
folder=pathlib.Path.home()/'.local/share/tmux-mobile/attachments'/ident
folder.mkdir(mode=0o700,parents=True,exist_ok=False)
target=folder/name
size=0
check=hashlib.sha256()
try:
    with target.open('xb') as out:
        os.chmod(target,0o600)
        while True:
            chunk=sys.stdin.buffer.read(65536)
            if not chunk: break
            size+=len(chunk)
            if size>int(expected): raise ValueError('unexpected size')
            check.update(chunk)
            out.write(chunk)
    if size!=int(expected) or check.hexdigest()!=digest: raise ValueError('incomplete transfer')
    print(json.dumps({'path':str(target.resolve()),'size':size,'sha256':digest}))
except BaseException:
    target.unlink(missing_ok=True)
    folder.rmdir()
    raise
'''


def safe_name(value):
    name = (value or 'attachment').replace('\\', '/').rsplit('/', 1)[-1]
    name = ''.join(char for char in name if char.isprintable()).strip()[:160]
    name = ''.join(char if char.isalnum() or char in ' ._()-' else '_' for char in name).strip(' .')
    return name or 'attachment'


class Attachments:
    def __init__(self, state, workspace):
        self.root = Path(state) / 'attachments'
        self.previews = Path(state) / 'attachment-previews'
        self.workspace = workspace
        self.slots = asyncio.Semaphore(2)
        self.active = set()

    def make_preview(self, ident, source, name):
        """A small, persistent chat asset; the task's temporary input is separate."""
        if not re.fullmatch(r'[a-f0-9]{32}', ident):
            return False
        target = self.previews / (ident + '.webp')
        if target.is_file():
            return True
        try:
            with Image.open(source) as original:
                if original.width * original.height > 40000000:
                    return False
                image = ImageOps.exif_transpose(original)
                image.thumbnail((1280, 1280))
                image = image.convert('RGBA' if 'A' in image.getbands() else 'RGB')
                self.previews.mkdir(mode=0o700, parents=True, exist_ok=True)
                temporary = target.with_suffix('.tmp')
                with temporary.open('wb') as output:
                    temporary.chmod(0o600)
                    image.save(output, format='WEBP', quality=84)
                temporary.replace(target)
            return True
        except (OSError, ValueError, UnidentifiedImageError, Image.DecompressionBombError):
            target.with_suffix('.tmp').unlink(missing_ok=True)
            return False

    async def preview(self, ident):
        if not re.fullmatch(r'[a-f0-9]{32}', ident):
            raise web.HTTPNotFound(text='첨부 미리보기를 찾을 수 없어요.')
        target = self.previews / (ident + '.webp')
        if not target.is_file():
            try:
                folder = self.root / ident
                record = json.loads((folder / '.attachment-metadata').read_text())
                source = folder / safe_name(record['name'])
                await asyncio.to_thread(self.make_preview, ident, source, record['name'])
            except (OSError, ValueError, KeyError):
                pass
        if not target.is_file() or target.is_symlink():
            raise web.HTTPNotFound(text='첨부 미리보기가 없어요.')
        return web.FileResponse(target, headers={'Content-Type': 'image/webp'})

    async def upload(self, request, pid, owner):
        host, raw = self.workspace.resolve(pid, '%')
        await self.workspace.backends[host.id].pane(raw, fresh=True)
        if request.content_length is not None and request.content_length > MAX_FILE_SIZE + 65536:
            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE_SIZE, actual_size=request.content_length)
        async with self.slots:
            try:
                reader = await request.multipart()
                part = await reader.next()
            except (ValueError, AssertionError):
                raise web.HTTPBadRequest(text='첨부할 파일을 선택해 주세요.')
            if part is None or part.name != 'file' or part.filename is None:
                raise web.HTTPBadRequest(text='첨부할 파일을 선택해 주세요.')
            ident, name = secrets.token_hex(16), safe_name(part.filename)
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            folder = self.root / ident
            folder.mkdir(mode=0o700)
            self.active.add(ident)
            target = folder / name
            size, digest = 0, hashlib.sha256()
            try:
                with target.open('xb') as output:
                    target.chmod(0o600)
                    while chunk := await part.read_chunk(65536):
                        size += len(chunk)
                        if size > MAX_FILE_SIZE:
                            raise web.HTTPRequestEntityTooLarge(max_size=MAX_FILE_SIZE, actual_size=size)
                        digest.update(chunk)
                        output.write(chunk)
                if await reader.next() is not None:
                    raise web.HTTPBadRequest(text='파일은 한 개씩 업로드해 주세요.')
                checksum = digest.hexdigest()
                preview = await asyncio.to_thread(self.make_preview, ident, target, name)
                destination = str(target.resolve())
                if not host.local:
                    destination = await self.deliver(host, target, ident, name, size, checksum)
                record = {'id': ident, 'name': name, 'size': size, 'host': host.id, 'path': destination,
                          'owner': hashlib.sha256(owner.encode()).hexdigest(), 'sha256': checksum,
                          'created': time.time(), 'sent_at': None, 'preview': preview}
                # Filename and metadata must remain separate even when the upload is JSON.
                meta = folder / '.attachment-metadata'
                descriptor = os.open(meta, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, 'w') as output:
                    json.dump(record, output, ensure_ascii=False)
                if not host.local:
                    target.unlink()  # Keep no second copy on the relay server.
                return {key: record[key] for key in ['id', 'name', 'size', 'host', 'preview']}
            except BaseException:
                target.unlink(missing_ok=True)
                (folder / '.attachment-metadata').unlink(missing_ok=True)
                (self.previews / (ident + '.webp')).unlink(missing_ok=True)
                folder.rmdir()
                raise
            finally:
                self.active.discard(ident)

    async def deliver(self, host, source, ident, name, size, checksum):
        with source.open('rb') as stream:
            process = await asyncio.create_subprocess_exec(
                *host.ssh(['python3', '-c', REMOTE_SAVE, ident, name, str(size), checksum]),
                stdin=stream, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                output, _ = await asyncio.wait_for(process.communicate(), timeout=120)
            except BaseException as error:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                if isinstance(error, asyncio.TimeoutError):
                    raise web.HTTPGatewayTimeout(text='서버에 파일을 보내는 시간이 초과됐어요. 다시 보내 주세요.')
                raise
        if process.returncode:
            raise web.HTTPServiceUnavailable(text='선택한 서버에 파일을 저장하지 못했어요. SSH 연결을 확인해 주세요.')
        try:
            result = json.loads(output)
            destination = result['path']
            if not isinstance(destination, str) or not destination.startswith('/') or any(ord(c) < 32 for c in destination):
                raise ValueError()
            if result['size'] != size or result['sha256'] != checksum:
                raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise web.HTTPBadGateway(text='서버의 파일 저장 결과를 확인할 수 없어요.')
        return destination

    def message(self, pid, payload, owner):
        ids = payload.get('attachments', [])
        if not isinstance(ids, list) or len(ids) > MAX_ATTACHMENTS or len(set(str(item) for item in ids)) != len(ids):
            raise web.HTTPBadRequest(text='파일은 한 번에 최대 5개까지 보낼 수 있어요.')
        if not ids:
            return payload
        host, _ = self.workspace.resolve(pid, '%')
        records = []
        for ident in ids:
            if not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{32}', ident):
                raise web.HTTPBadRequest(text='잘못된 첨부 파일이에요.')
            try:
                record = json.loads((self.root / ident / '.attachment-metadata').read_text())
            except FileNotFoundError:
                raise web.HTTPNotFound(text='첨부 파일을 다시 선택해 주세요.')
            if record['owner'] != hashlib.sha256(owner.encode()).hexdigest() or record['host'] != host.id:
                raise web.HTTPForbidden(text='이 서버나 로그인에서 보낼 수 없는 첨부 파일이에요.')
            records.append(record)
        text = payload.get('text', '')
        if not isinstance(text, str):
            raise web.HTTPBadRequest(text='잘못된 메시지예요.')
        paths = '\n'.join('- ' + json.dumps(item['path'], ensure_ascii=False) for item in records)
        cleanup = '\n\n첨부 파일은 임시 입력입니다. 작업을 마치면 위 임시 원본과 처리용 임시 파일을 삭제하세요. 사용자가 저장 위치를 지정한 파일·결과물은 그 위치에 보관하고 임시 사본만 삭제하세요.'
        return {**payload, 'text': (text.rstrip() + '\n\n' if text.strip() else '') + '첨부 파일 (이 서버에 저장된 임시 원본):\n' + paths + cleanup}

    def mark_sent(self, ids):
        for ident in ids:
            path = self.root / ident / '.attachment-metadata'
            try:
                record = json.loads(path.read_text())
                if record.get('sent_at'):
                    continue
                record['sent_at'] = time.time()
                temporary = path.with_suffix('.tmp')
                descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(descriptor, 'w') as output:
                    json.dump(record, output, ensure_ascii=False)
                temporary.replace(path)
            except FileNotFoundError:
                pass  # A fast consumer may already have removed its temporary input.

    async def remove(self, ident, owner=None):
        if not re.fullmatch(r'[a-f0-9]{32}', ident):
            raise web.HTTPNotFound(text='첨부 파일을 찾을 수 없어요.')
        folder = self.root / ident
        try:
            record = json.loads((folder / '.attachment-metadata').read_text())
        except FileNotFoundError:
            return
        if owner is not None:
            if record['owner'] != hashlib.sha256(owner.encode()).hexdigest():
                raise web.HTTPForbidden(text='이 로그인에서 지울 수 없는 파일이에요.')
            if record.get('sent_at'):
                return  # An uncertain response may already have delivered this file to a running task.
        host = self.workspace.hosts[record['host']]
        if not host.local:
            process = await asyncio.create_subprocess_exec(*host.ssh(['python3', '-c', REMOTE_DELETE, ident]),
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                await asyncio.wait_for(process.communicate(), timeout=15)
            except BaseException:
                if process.returncode is None:
                    process.kill()
                await process.wait()
                raise
            if process.returncode:
                raise web.HTTPServiceUnavailable(text='서버 연결 후 임시 파일 정리를 다시 시도할게요.')
        shutil.rmtree(folder)
        if not record.get('sent_at'):
            (self.previews / (ident + '.webp')).unlink(missing_ok=True)

    async def sweep(self):
        if not self.root.exists():
            return
        now = time.time()
        for folder in self.root.iterdir():
            if not re.fullmatch(r'[a-f0-9]{32}', folder.name) or folder.is_symlink() or folder.name in self.active:
                continue
            try:
                record = json.loads((folder / '.attachment-metadata').read_text())
            except FileNotFoundError:
                if now - folder.stat().st_mtime > UNSENT_TTL:
                    shutil.rmtree(folder)
                continue
            sent = record.get('sent_at')
            expired = now - (sent or record.get('created', folder.stat().st_mtime)) > (SENT_TTL if sent else UNSENT_TTL)
            host = self.workspace.hosts.get(record['host'])
            consumed = host and host.local and not (folder / record['name']).exists()
            if expired or consumed:
                try:
                    await self.remove(folder.name)
                except (web.HTTPException, asyncio.TimeoutError, OSError):
                    pass  # Keep the receipt so the next pass can retry remote cleanup.
