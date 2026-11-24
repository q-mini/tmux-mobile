"""Stream a file into an existing directory, without replacing existing entries.

The same worker runs locally and over the selected server's authenticated SSH.
"""
import json
import os
from pathlib import Path
import secrets
import signal
import sys


def receive(options, source):
    path, name, expected = options.get('path'), options.get('name'), options.get('size')
    if not isinstance(path, str) or len(path) > 4096 or '\0' in path:
        raise ValueError('첨부할 폴더를 선택해 주세요.')
    if (not isinstance(name, str) or name in {'', '.', '..'} or len(os.fsencode(name)) > 255
            or any(c in name for c in '/\\') or any(ord(c) < 32 for c in name)):
        raise ValueError('첨부할 파일 이름을 확인해 주세요.')
    if type(expected) is not int or not 0 <= expected <= 2**63-1:
        raise ValueError('첨부할 파일 크기를 확인해 주세요.')
    folder = Path(path or str(Path.home())).expanduser().resolve(strict=True)
    directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
    temporary = '.q-upload-' + secrets.token_hex(16)
    created = False
    try:
        if os.path.lexists(folder / name):
            raise FileExistsError('같은 이름이 있어 첨부하지 않았어요: ' + name)
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory)
        created = True
        with os.fdopen(descriptor, 'wb') as output:
            received = 0
            while True:
                chunk = source.read(min(65536, expected - received + 1))
                if not chunk:
                    break
                received += len(chunk)
                if received > expected:
                    raise ValueError('파일 크기가 달라 첨부를 취소했어요.')
                output.write(chunk)
            if received != expected:
                raise ValueError('전송이 중단되어 첨부를 취소했어요.')
            output.flush()
            os.fsync(output.fileno())
        # Atomic no-replace publication, including when another upload wins a race.
        try:
            os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        except FileExistsError:
            raise FileExistsError('같은 이름이 있어 첨부하지 않았어요: ' + name)
        return {'ok': True, 'path': str(folder / name), 'name': name, 'bytes': received}
    finally:
        if created:
            os.unlink(temporary, dir_fd=directory)
        os.close(directory)


def main():
    def interrupted(signum, frame):
        raise InterruptedError('파일 전송이 중단됐어요.')
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        header = sys.stdin.buffer.readline(16384)
        result = receive(json.loads(header), sys.stdin.buffer)
    except FileExistsError as error:
        result = {'error': str(error), 'status': 409}
    except FileNotFoundError:
        result = {'error': '첨부할 폴더를 찾을 수 없어요.', 'status': 404}
    except PermissionError:
        result = {'error': '이 폴더에 파일을 첨부할 권한이 없어요.', 'status': 403}
    except (ValueError, OSError) as error:
        result = {'error': str(error), 'status': 400}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
