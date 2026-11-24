"""Verify the owned origin, then run and monitor cloudflared in the foreground."""
import asyncio
import contextlib
import os
from pathlib import Path
import re
import signal
import sys

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.state'


async def main():
    url_file = STATE / 'public-url'
    url_file.unlink(missing_ok=True)
    origin = ''
    instance = ''
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=3)) as client:
        async def check_origin():
            try:
                async with client.get(origin + '/healthz') as response:
                    value = await response.json()
                    return response.status == 200 and value.get('app') == 'tmux-mobile' and value.get('instance') == instance
            except (aiohttp.ClientError, OSError, ValueError, asyncio.TimeoutError):
                return False

        for attempt in range(10):
            try:
                origin = (STATE / 'listen-url').read_text().strip()
                instance = (STATE / 'instance-id').read_text()
            except FileNotFoundError:
                print('Waiting for origin startup metadata...', flush=True)
                await asyncio.sleep(0.5)
                continue
            if not re.fullmatch(r'http://127\.0\.0\.1:\d+', origin):
                raise SystemExit('Origin must be a loopback listener')
            if await check_origin():
                break
            print('Waiting for the owned tmux-mobile origin...', flush=True)
            await asyncio.sleep(0.5)
        else:
            raise SystemExit('Refusing to expose an unavailable or unexpected service')
        command = [str(ROOT / 'bin/cloudflared'), 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', origin, '--metrics', '127.0.0.1:20241', '--grace-period', '1s']
        print('Verified tmux-mobile origin identity on its atomically reserved port.', flush=True)
        print('$', ' '.join(command), flush=True)
        process = await asyncio.create_subprocess_exec(*command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        for signum in [signal.SIGTERM, signal.SIGINT]:
            loop.add_signal_handler(signum, stopped.set)
        (STATE / 'tunnel.pid').write_text(str(os.getpid()))

        async def print_output():
            async for raw in process.stdout:
                line = raw.decode(errors='replace')
                print(line, end='', flush=True)
                match = re.search(r'https://[a-z0-9-]+\.trycloudflare\.com', line)
                if match:
                    url_file.write_text(match.group())
                    print('Public URL saved; login required.', flush=True)
            stopped.set()

        async def monitor():
            while not stopped.is_set():
                try:
                    await asyncio.wait_for(stopped.wait(), timeout=2)
                except asyncio.TimeoutError:
                    if not await check_origin():
                        print('Origin identity lost. Closing public tunnel.', flush=True)
                        stopped.set()

        output = asyncio.create_task(print_output())
        watchdog = asyncio.create_task(monitor())
        try:
            await stopped.wait()
        finally:
            if process.returncode is None:
                process.terminate()
            try:
                result = await asyncio.wait_for(process.wait(), timeout=4)
            except asyncio.TimeoutError:
                process.kill()
                result = await process.wait()
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watchdog
            await output
            url_file.unlink(missing_ok=True)
        print('cloudflared exit_status=' + str(result), flush=True)
        return 0 if result == -signal.SIGTERM else result


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
