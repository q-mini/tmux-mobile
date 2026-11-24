"""Persistent per-browser connections. The device ID is not a credential."""
from contextlib import contextmanager
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import time

YEAR = 365 * 24 * 3600
SESSION = 12 * 3600


def device_label(agent):
    system = ('iPad' if 'iPad' in agent or ('Macintosh' in agent and 'Mobile/' in agent)
              else 'iPhone' if 'iPhone' in agent else 'Android' if 'Android' in agent
              else 'Mac' if 'Mac' in agent else 'Windows' if 'Windows' in agent
              else 'Linux' if 'Linux' in agent else '브라우저')
    browser = ('Edge' if 'Edg' in agent else 'Chrome' if 'Chrome' in agent or 'CriOS' in agent
               else 'Firefox' if 'Firefox' in agent or 'FxiOS' in agent
               else 'Safari' if 'Safari' in agent else '')
    return ' · '.join(filter(None, (system, browser)))


def device_id(value):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_-]{16,80}', value) else secrets.token_urlsafe(18)


class DeviceSessions:
    def __init__(self, path, key):
        self.path, self.key = Path(path), key

    def fingerprint(self, identifier):
        with self.records() as records:
            return records.get(identifier, {}).get('token', '')

    @contextmanager
    def records(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(self.path) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
        with os.fdopen(fd, 'a+') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                data = json.loads(self.path.read_text())
                records = data.get('devices', {}) if data.get('key') == hashlib.sha256(self.key().encode()).hexdigest() else {}
            except (OSError, ValueError, TypeError, AttributeError):
                records = {}
            before = json.dumps(records, sort_keys=True)
            records = {identifier: item for identifier, item in records.items()
                       if isinstance(item, dict) and item.get('expires', 0) > time.time()}
            yield records
            if json.dumps(records, sort_keys=True) != before or not self.path.exists():
                payload = {'key': hashlib.sha256(self.key().encode()).hexdigest(), 'devices': records}
                temp = self.path.with_name(self.path.name + '.tmp')
                fd = os.open(temp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
                with os.fdopen(fd, 'w') as stream:
                    json.dump(payload, stream)
                temp.chmod(0o600)
                temp.replace(self.path)

    @staticmethod
    def digest(token):
        return hashlib.sha256(token.encode()).hexdigest()

    def valid(self, token):
        if not token:
            return False
        digest = self.digest(token)
        with self.records() as records:
            return any(hmac.compare_digest(item['token'], digest) for item in records.values())

    def remembered(self, token):
        digest = self.digest(token or '')
        with self.records() as records:
            return next((item.get('remember', True) for item in records.values()
                         if hmac.compare_digest(item['token'], digest)), False)

    def bind(self, token, identifier, agent, remember=None):
        if remember is not None and type(remember) is not bool:
            raise ValueError('로그인 저장 여부를 확인해 주세요.')
        identifier = device_id(identifier)
        now, digest = time.time(), self.digest(token)
        with self.records() as records:
            existing = next((key for key, item in records.items() if hmac.compare_digest(item['token'], digest)), None)
            identifier = existing or identifier
            # Reauthentication creates a fresh credential. Revoked cookies must
            # never become valid again when the same browser signs in later.
            credential = token if existing else secrets.token_urlsafe(32)
            original = records.get(identifier, {})
            remember = original.get('remember', True) if remember is None and original else bool(remember)
            records[identifier] = {'token': self.digest(credential), 'created': original.get('created', now),
                                   'last_seen': now, 'expires': now + (YEAR if remember else SESSION),
                                   'remember': remember, 'label': device_label(agent)}
        return credential

    def list(self, token):
        digest = self.digest(token)
        with self.records() as records:
            return [{'id': identifier, 'label': item['label'], 'last_seen': item['last_seen'],
                     'remember': item.get('remember', True),
                     'current': hmac.compare_digest(item['token'], digest)} for identifier, item in records.items()]

    def revoke(self, identifier):
        with self.records() as records:
            return records.pop(identifier, None) is not None

    def revoke_all(self):
        with self.records() as records:
            count = len(records)
            records.clear()
            return count

    def revoke_many(self, identifiers):
        if not isinstance(identifiers, list) or not 0 < len(identifiers) <= 128 or any(not isinstance(item, str) for item in identifiers):
            raise ValueError('해제할 기기를 선택해 주세요.')
        with self.records() as records:
            if any(identifier not in records for identifier in identifiers):
                raise KeyError('기기 목록이 바뀌었어요. 다시 확인해 주세요.')
            return {identifier: records.pop(identifier)['token'] for identifier in dict.fromkeys(identifiers)}
