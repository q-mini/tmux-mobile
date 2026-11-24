"""Shared local accounts for Q's three apps; opaque, app-scoped device sessions."""
from contextlib import contextmanager
import hashlib
import hmac
from http.cookies import SimpleCookie
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import string
import threading
import time

DEFAULT_DB=Path.home()/'.local/share/tmux-mobile/accounts.sqlite3'
YEAR=365*86400
SESSION=12*3600


class AccountError(ValueError):
    def __init__(self,message,status=400):super().__init__(message);self.status=status


def password_hash(value,salt=None):
    if (not isinstance(value,str) or not 10<=len(value)<=1024 or not re.search(r'[A-Za-z]',value)
            or not re.search(r'[0-9]',value) or not any(char in string.punctuation for char in value)):
        raise AccountError('비밀번호는 10~1024자이며 영문·숫자·특수문자를 각각 포함해야 해요.')
    salt=salt or secrets.token_bytes(16)
    digest=hashlib.scrypt(value.encode('utf-8'),salt=salt,n=32768,r=8,p=3,dklen=32,maxmem=64*1024*1024)
    return 'scrypt:32768:8:3:'+salt.hex()+':'+digest.hex()


def password_matches(value,stored):
    if not isinstance(value,str) or not 1<=len(value)<=1024:return False
    try:
        method,n,r,p,salt,digest=stored.split(':')
        if (method,n,r,p)!=('scrypt','32768','8','3'):return False
        actual=hashlib.scrypt(value.encode('utf-8'),salt=bytes.fromhex(salt),n=int(n),r=int(r),p=int(p),dklen=32,maxmem=64*1024*1024)
        return hmac.compare_digest(actual.hex(),digest)
    except (ValueError,TypeError):return False


def digest(value):return hashlib.sha256(value.encode()).hexdigest()


class Accounts:
    def __init__(self,path=None):self.path=Path(path or DEFAULT_DB);self.work=threading.BoundedSemaphore(4)

    @contextmanager
    def db(self):
        self.path.parent.mkdir(parents=True,exist_ok=True)
        fd=os.open(self.path,os.O_CREAT|os.O_RDWR,0o600);os.close(fd);self.path.chmod(0o600)
        db=sqlite3.connect(self.path,timeout=10);db.row_factory=sqlite3.Row
        try:
            db.execute('PRAGMA foreign_keys=ON')
            db.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password TEXT NOT NULL,recovery TEXT NOT NULL,created REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,id TEXT UNIQUE NOT NULL,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,app TEXT NOT NULL,device TEXT NOT NULL,label TEXT NOT NULL,remember INTEGER NOT NULL,created REAL NOT NULL,seen REAL NOT NULL,expires REAL NOT NULL,UNIQUE(user_id,app,device));
            CREATE TABLE IF NOT EXISTS attempts(bucket TEXT NOT NULL,stamp REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS grants(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,app TEXT NOT NULL,PRIMARY KEY(user_id,app));
            CREATE INDEX IF NOT EXISTS attempts_bucket ON attempts(bucket,stamp);''')
            with db:yield db
        finally:db.close()

    @staticmethod
    def username(value):
        if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{2,39}',value):raise AccountError('ID는 영문·숫자·._- 조합으로 3~40자를 입력해 주세요.')
        return value.casefold()

    def session(self,token,app=None):
        if not isinstance(token,str) or not token.startswith('qa_') or len(token)>100 or not self.path.exists():return None
        with self.db() as db:
            row=db.execute('SELECT s.*,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',(digest(token),time.time())).fetchone()
            return dict(row) if row and (app is None or row['app']==app) else None

    def throttle(self,peer,username=''):
        buckets=[digest('ip:'+str(peer))]+([digest('user:'+username)] if username else [])
        now=time.time()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE');db.execute('DELETE FROM attempts WHERE stamp<?',(now-60,))
            if any(db.execute('SELECT COUNT(*) FROM attempts WHERE bucket=?',(b,)).fetchone()[0]>=8 for b in buckets):raise AccountError('1분 뒤에 다시 시도해 주세요.',429)
            db.executemany('INSERT INTO attempts VALUES(?,?)',[(b,now) for b in buckets])

    def new_session(self,user,app,device,agent,remember,expected_password=None):
        if type(remember) is not bool:raise AccountError('로그인 저장 여부를 확인해 주세요.')
        from .device_sessions import device_id,device_label
        device=device_id(device);token='qa_'+secrets.token_urlsafe(32);now=time.time()
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT password FROM users WHERE id=?',(user,)).fetchone()
            if not row or expected_password and not hmac.compare_digest(row['password'],expected_password):raise AccountError('계정 정보가 바뀌었어요. 다시 로그인해 주세요.',409)
            if not db.execute('SELECT 1 FROM grants WHERE user_id=? AND app=?',(user,app)).fetchone():raise AccountError('이 앱의 접속키로 계정을 연결해 주세요.',403)
            db.execute('DELETE FROM sessions WHERE expires<=?',(now,))
            if db.execute('SELECT COUNT(*) FROM sessions WHERE user_id=?',(user,)).fetchone()[0]>=128:raise AccountError('연결된 기기가 너무 많아요. 설정에서 정리해 주세요.')
            db.execute('DELETE FROM sessions WHERE user_id=? AND app=? AND device=?',(user,app,device))
            db.execute('INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?)',(digest(token),secrets.token_hex(12),user,app,device,device_label(agent),int(remember),now,now,now+(YEAR if remember else SESSION)))
        return token

    def devices(self,token,app=None):
        current=self.session(token)
        if not current:raise AccountError('로그인이 필요해요.',401)
        with self.db() as db:
            rows=db.execute('SELECT * FROM sessions WHERE user_id=? AND expires>? ORDER BY seen DESC',(current['user_id'],time.time())).fetchall()
        return [{'id':r['id'],'app':r['app'],'label':r['label'],'remember':bool(r['remember']),'last_seen':r['seen'],'current':hmac.compare_digest(r['token'],digest(token))} for r in rows if not app or r['app']==app]

    def revoke(self,token,body,app=None):
        items=self.devices(token,app);ids=[i['id'] for i in items] if body.get('all') is True else body.get('ids',[body.get('id')])
        if not isinstance(ids,list) or not ids or len(ids)>128 or any(not isinstance(i,str) or i not in {x['id'] for x in items} for i in ids):raise AccountError('해제할 기기를 선택해 주세요.')
        with self.db() as db:db.executemany('DELETE FROM sessions WHERE id=?',[(i,) for i in set(ids)])
        return {'ok':True,'removed':len(set(ids)),'current':any(i['current'] and i['id'] in ids for i in items)}

    def bind(self,token,app,remember=None):
        current=self.session(token,app)
        if not current:raise AccountError('로그인이 필요해요.',401)
        if remember is not None and type(remember) is not bool:raise AccountError('로그인 저장 여부를 확인해 주세요.')
        remember=bool(current['remember']) if remember is None else remember
        with self.db() as db:db.execute('UPDATE sessions SET remember=?,seen=?,expires=? WHERE token=?',(int(remember),time.time(),time.time()+(YEAR if remember else SESSION),digest(token)))
        return {'ok':True,'remember':remember}

    def handle(self,method,body,token,app,key,peer,agent,*,bootstrap=False):
        """Return (payload, new-cookie-or-None, clear-cookie). No secret logging."""
        current=self.session(token,app)
        if method=='GET':return {'user':{'username':current['username']} if current else None},None,False
        if not isinstance(body,dict):raise AccountError('잘못된 요청이에요.')
        if 'remember' in body and type(body['remember']) is not bool:raise AccountError('로그인 저장 여부를 확인해 주세요.')
        action=body.get('action')
        if action in {'login','register','reset'}:
            username=self.username(body.get('username'));self.throttle(peer,username)
            if not self.work.acquire(blocking=False):raise AccountError('잠시 뒤에 다시 시도해 주세요.',429)
            try:
                if action=='register':
                    if not bootstrap:raise AccountError('먼저 접속키로 로그인한 뒤 설정에서 계정을 만들어 주세요.',401)
                    hashed=password_hash(body.get('password'));recovery=secrets.token_urlsafe(24)
                    try:
                        with self.db() as db:
                            user=db.execute('INSERT INTO users(username,password,recovery,created) VALUES(?,?,?,?)',(username,hashed,digest(recovery),time.time())).lastrowid
                            db.execute('INSERT INTO grants VALUES(?,?)',(user,app))
                    except sqlite3.IntegrityError:raise AccountError('이미 사용 중인 ID예요.',409)
                    credential=self.new_session(user,app,body.get('device_id'),agent,body.get('remember',False),hashed)
                    return {'ok':True,'recovery_code':recovery},credential,False
                with self.db() as db:row=db.execute('SELECT * FROM users WHERE username=?',(username,)).fetchone()
                if action=='login':
                    dummy='scrypt:32768:8:3:'+'00'*16+':'+'00'*32
                    good=password_matches(body.get('password'),row['password'] if row else dummy)
                    if not row or not good:raise AccountError('ID 또는 비밀번호가 맞지 않아요.',401)
                    with self.db() as db:
                        granted=db.execute('SELECT 1 FROM grants WHERE user_id=? AND app=?',(row['id'],app)).fetchone()
                        if not granted:
                            supplied=body.get('key','')
                            if not bootstrap and (not isinstance(supplied,str) or not supplied or not hmac.compare_digest(supplied.encode(),key.encode())):raise AccountError('이 앱의 접속키로 계정을 연결해 주세요.',403)
                            db.execute('INSERT INTO grants VALUES(?,?)',(row['id'],app))
                    return {'ok':True},self.new_session(row['id'],app,body.get('device_id'),agent,body.get('remember',False),row['password']),False
                recovery=body.get('recovery_code','')
                if not row or not isinstance(recovery,str) or len(recovery)>200 or not hmac.compare_digest(digest(recovery),row['recovery']):raise AccountError('ID 또는 복구 코드를 확인해 주세요.',401)
                hashed=password_hash(body.get('password'));new_recovery=secrets.token_urlsafe(24)
                with self.db() as db:
                    result=db.execute('UPDATE users SET password=?,recovery=? WHERE id=? AND recovery=?',(hashed,digest(new_recovery),row['id'],row['recovery']))
                    if not result.rowcount:raise AccountError('복구 코드가 이미 사용됐어요.',409)
                    db.execute('DELETE FROM sessions WHERE user_id=?',(row['id'],))
                return {'ok':True,'recovery_code':new_recovery},None,True
            finally:self.work.release()
        if not current:raise AccountError('로그인이 필요해요.',401)
        if action=='devices':return {'devices':self.devices(token)},None,False
        if action=='revoke':
            result=self.revoke(token,body);return result,None,result['current']
        if action=='logout':
            with self.db() as db:db.execute('DELETE FROM sessions WHERE token=?',(digest(token),))
            return {'ok':True},None,True
        if action not in {'password','recovery','username','delete'}:raise AccountError('지원하지 않는 요청이에요.')
        self.throttle(peer,current['username'])
        if not self.work.acquire(blocking=False):raise AccountError('잠시 뒤에 다시 시도해 주세요.',429)
        try:
            with self.db() as db:row=db.execute('SELECT * FROM users WHERE id=?',(current['user_id'],)).fetchone()
            if not row or not password_matches(body.get('current_password'),row['password']):raise AccountError('현재 비밀번호를 확인해 주세요.',401)
            result={'ok':True}
            with self.db() as db:
                db.execute('BEGIN IMMEDIATE')
                live=db.execute('SELECT password FROM users WHERE id=?',(row['id'],)).fetchone()
                if not live or live['password']!=row['password'] or not db.execute('SELECT 1 FROM sessions WHERE token=? AND expires>?',(digest(token),time.time())).fetchone():raise AccountError('계정 정보가 바뀌었어요. 다시 로그인해 주세요.',409)
                if action=='password':
                    hashed=password_hash(body.get('password'))
                    changed=db.execute('UPDATE users SET password=? WHERE id=? AND password=?',(hashed,row['id'],row['password']))
                    if not changed.rowcount:raise AccountError('계정 정보가 바뀌었어요. 다시 로그인해 주세요.',409)
                    db.execute('DELETE FROM sessions WHERE user_id=? AND token<>?',(row['id'],digest(token)))
                elif action=='recovery':
                    recovery=secrets.token_urlsafe(24);db.execute('UPDATE users SET recovery=? WHERE id=?',(digest(recovery),row['id']));result['recovery_code']=recovery
                elif action=='username':
                    try:db.execute('UPDATE users SET username=? WHERE id=?',(self.username(body.get('username')),row['id']))
                    except sqlite3.IntegrityError:raise AccountError('이미 사용 중인 ID예요.',409)
                else:db.execute('DELETE FROM users WHERE id=?',(row['id'],))
            return result,None,action=='delete'
        finally:self.work.release()

