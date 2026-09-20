"""Cross-package official Windows Python; no Python installation needed on users' PCs."""
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile

VERSION = '3.14.7'
# https://www.python.org/downloads/release/python-3147/
SHA256 = 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15'
root = Path(__file__).resolve().parent.parent
runtime = root / 'desktop-runtime/win-x64'
runtime.mkdir(parents=True, exist_ok=True)
archive = runtime / f'python-{VERSION}-embed-amd64.zip'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
    url = f'https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip'
    print(f'Downloading {url}', flush=True)
    with urllib.request.urlopen(url, timeout=90) as response, archive.open('wb') as output:
        shutil.copyfileobj(response, output)
if hashlib.sha256(archive.read_bytes()).hexdigest() != SHA256:
    raise RuntimeError('Official Python archive SHA-256 did not match')
target = runtime / 'python'
if target.exists():
    shutil.rmtree(target)
with zipfile.ZipFile(archive) as package:
    package.extractall(target)
(target / 'desktop').mkdir()
(target / 'api').mkdir()
(target / 'api/__init__.py').write_text('', encoding='utf-8')
shutil.copyfile(root / 'desktop/python-worker.py', target / 'desktop/python-worker.py')
for name in ['python_parse.py', 'python_image.py', 'python_video.py']:
    shutil.copyfile(root / 'api' / name, target / 'api' / name)
# The official embedded Python loads Windows' certificate stores. Do not install
# packages into the user's system or modify their PATH/registry.
info = {'platform': 'win32', 'arch': 'AMD64', 'python': VERSION, 'kind': 'embedded', 'sha256': SHA256}
(runtime / 'build-info.json').write_text(json.dumps(info), encoding='utf-8')
if sys.platform == 'win32':
    subprocess.run([str(target / 'python.exe'), str(target / 'desktop/python-worker.py'), '--health'], check=True)
print(f'Windows embedded Python ready: {target}')
