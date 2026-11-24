#!/usr/bin/python3
"""OpenSSH asks here once; the password is read from a private temporary socket."""
import os
import socket
import sys

with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
    client.settimeout(5)
    client.connect(os.environ['TMUX_SETUP_SOCKET'])
    client.sendall(b'P')
    chunks = []
    while True:
        chunk = client.recv(2048)
        if not chunk:
            break
        chunks.append(chunk)
sys.stdout.buffer.write(b''.join(chunks) + b'\n')
