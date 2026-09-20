"""Build with a pinned relocatable Python, keeping macOS 13 support on newer hosts.

Source: https://github.com/astral-sh/python-build-standalone/releases/tag/20260901
The verified runtime stays inside this repository; nothing is installed globally.
"""
from pathlib import Path
import hashlib
import platform
import subprocess
import sys
import tarfile
import urllib.request

if sys.platform != 'darwin':
    raise SystemExit('Run this script on the target Mac architecture, or use the desktop CI matrix.')
ARCHIVES = {
    'arm64': ('aarch64', 'd3904bd6a072246e07aa0bdadee9a14e80521e42a943c0848059feb16a2816dc'),
    'x86_64': ('x86_64', 'f712a9143c8a5d248438ec7921a0b48d548bca4f1337d33c690d28c2d0504137'),
}
architecture, digest = ARCHIVES[platform.machine()]
root = Path(__file__).resolve().parent.parent
base = root / 'desktop-runtime' / f'build-python-{architecture}'
base.mkdir(parents=True, exist_ok=True)
archive = base / 'python.tar.gz'
name = f'cpython-3.13.15%2B20260901-{architecture}-apple-darwin-install_only_stripped.tar.gz'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
    url = f'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/{name}'
    print(f'Downloading {url}', flush=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        archive.write_bytes(response.read())
if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
    raise RuntimeError('Portable Python archive SHA-256 did not match')
with tarfile.open(archive) as package:
    package.extractall(base, filter='data')
subprocess.run([str(base / 'python/bin/python3.13'), str(root / 'scripts/build-python.py')], cwd=root, check=True)
