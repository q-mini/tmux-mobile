"""Shared sidebar organization. Mutations merge by folder field, never by snapshot."""
import copy
import json
import os
from pathlib import Path


class NavigationStore:
    def __init__(self, path):
        self.path = Path(path)
        try:
            self.data = json.loads(self.path.read_text())
        except FileNotFoundError:
            self.data = {'revision': 0, 'hosts': {}}

    def snapshot(self):
        return copy.deepcopy({key: self.data[key] for key in ('revision', 'hosts')})

    @staticmethod
    def identifier(value, empty=False):
        if not isinstance(value, str) or (not value and not empty) or len(value) > 160 or any(ord(c) < 32 for c in value):
            raise ValueError('폴더 식별자가 올바르지 않아요.')
        return value

    def folder(self, value, partial=False):
        if not isinstance(value, dict):
            raise ValueError('폴더 정보가 올바르지 않아요.')
        result = {'id': self.identifier(value.get('id'))}
        for field in ('name', 'parent', 'collapsed'):
            if field not in value and partial:
                continue
            item = value.get(field, False if field == 'collapsed' else '')
            if field == 'name':
                if not isinstance(item, str) or not item.strip() or len(item) > 80:
                    raise ValueError('폴더 이름을 80자 이내로 입력해 주세요.')
                item = item.strip()
            elif field == 'parent':
                self.identifier(item, empty=True)
            elif type(item) is not bool:
                raise ValueError('폴더 펼침 상태가 올바르지 않아요.')
            result[field] = item
        return result

    def apply(self, payload, hosts):
        if not isinstance(payload, dict):
            raise ValueError('목록 변경 정보가 올바르지 않아요.')
        host = payload.get('host')
        if host not in hosts:
            raise ValueError('등록된 서버를 선택해 주세요.')
        operation = payload.get('id')
        if operation is not None:
            self.identifier(operation)
            if operation in self.data.get('applied', []):
                return self.snapshot()
        data = copy.deepcopy(self.data)
        old = copy.deepcopy(data['hosts'].get(host))
        current = data['hosts'].setdefault(host, {'folders': [], 'sessions': {}})
        if 'migrate' in payload:
            if old is not None:
                return self.snapshot()
            source = payload['migrate']
            if not isinstance(source, dict) or not isinstance(source.get('folders'), list) or not isinstance(source.get('sessions'), dict):
                raise ValueError('이전 폴더 정보가 올바르지 않아요.')
            current['folders'] = [self.folder(f) for f in source['folders']]
            current['sessions'] = source['sessions'].copy()
        else:
            changes = payload.get('folders', [])
            removed = payload.get('remove', [])
            sessions = payload.get('sessions', {})
            if not isinstance(changes, list) or not isinstance(removed, list) or not isinstance(sessions, dict):
                raise ValueError('목록 변경 정보가 올바르지 않아요.')
            # Deleting a folder lifts even children added concurrently by another device.
            for identifier in removed:
                self.identifier(identifier)
                entry = next((f for f in current['folders'] if f['id'] == identifier), None)
                if entry:
                    current['folders'].remove(entry)
                    for child in current['folders']:
                        if child['parent'] == identifier:
                            child['parent'] = entry['parent']
                    for sid, parent in current['sessions'].items():
                        if parent == identifier:
                            current['sessions'][sid] = entry['parent']
            for value in changes:
                change = self.folder(value, partial=True)
                entry = next((f for f in current['folders'] if f['id'] == change['id']), None)
                if entry:
                    entry.update(change)
                elif all(field in change for field in ('name', 'parent', 'collapsed')):
                    current['folders'].append(change)
                # A stale rename/toggle must not resurrect a deleted folder.
            for sid, parent in sessions.items():
                self.identifier(sid)
                if parent is None:
                    current['sessions'].pop(sid, None)
                else:
                    current['sessions'][sid] = parent
        if len(current['folders']) > 500 or len(current['sessions']) > 10000:
            raise ValueError('저장 가능한 목록 크기를 초과했어요.')
        index = {f['id']: f for f in current['folders']}
        if len(index) != len(current['folders']):
            raise ValueError('중복된 폴더 식별자예요.')
        for folder in current['folders']:
            if folder['parent'] not in index:
                folder['parent'] = ''
            seen, cursor = {folder['id']}, folder['parent']
            while cursor:
                if cursor in seen:
                    raise ValueError('폴더를 자기 자신이나 하위 폴더에 넣을 수 없어요.')
                seen.add(cursor)
                cursor = index[cursor]['parent']
        for sid, parent in current['sessions'].items():
            self.identifier(sid)
            self.identifier(parent, empty=True)
            if parent not in index:
                current['sessions'][sid] = ''
        if old == current:
            return self.snapshot()
        data['revision'] += 1
        if operation:
            data['applied'] = (data.get('applied', []) + [operation])[-1000:]
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, ensure_ascii=False)
        temporary.chmod(0o600)
        temporary.replace(self.path)
        self.data = data
        return self.snapshot()
