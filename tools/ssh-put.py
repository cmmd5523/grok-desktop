#!/usr/bin/env python3
"""Recursively upload a local directory to the remote server over SFTP.
Usage:
    python tools/ssh-put.py <local_dir> <remote_dir>
"""
import sys
import json
import os
import posixpath
import paramiko

BASE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BASE, "creds.json"), encoding="utf-8") as f:
    creds = json.load(f)

def main(local_dir, remote_dir):
    local_dir = os.path.abspath(local_dir)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=creds["host"],
        port=creds.get("port", 22),
        username=creds["user"],
        password=creds["password"],
        timeout=20,
        banner_timeout=20,
        auth_timeout=20,
        look_for_keys=False,
        allow_agent=False,
    )
    sftp = client.open_sftp()

    def ensure_dir(remote):
        parts = remote.strip("/").split("/")
        cur = ""
        for p in parts:
            cur = posixpath.join(cur, p) if cur else "/" + p
            try:
                sftp.stat(cur)
            except IOError:
                sftp.mkdir(cur)

    count = 0
    for root, dirs, files in os.walk(local_dir):
        rel = os.path.relpath(root, local_dir)
        target = remote_dir if rel == "." else posixpath.join(remote_dir, rel.replace(os.sep, "/"))
        ensure_dir(target)
        for f in files:
            local = os.path.join(root, f)
            remote = posixpath.join(target, f)
            sftp.put(local, remote)
            count += 1
            print(f"up {remote}")
    print(f"uploaded {count} files")
    sftp.close()
    client.close()

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: ssh-put.py <local_dir> <remote_dir>")
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
