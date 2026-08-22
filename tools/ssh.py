#!/usr/bin/env python3
"""Run a command on the remote server over SSH (paramiko). Usage:
    python tools/ssh.py "command here"
Optionally pass a list of commands separated by ';' — they run in one shell.
"""
import sys
import json
import os
import paramiko

BASE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BASE, "creds.json"), encoding="utf-8") as f:
    creds = json.load(f)

def run(cmd, timeout=120):
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
    try:
        stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout, get_pty=False)
        out = stdout.read().decode("utf-8", errors="replace")
        err = stderr.read().decode("utf-8", errors="replace")
        code = stdout.channel.recv_exit_status()
        return code, out, err
    finally:
        client.close()

if __name__ == "__main__":
    cmd = " ".join(sys.argv[1:])
    if not cmd:
        print("no command given")
        sys.exit(2)
    code, out, err = run(cmd)
    sys.stdout.write(out)
    if err.strip():
        sys.stderr.write("[stderr]\n" + err)
    sys.exit(code)
