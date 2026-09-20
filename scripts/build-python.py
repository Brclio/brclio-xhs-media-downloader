"""Developer build step: freeze Python plus TLS roots into a platform-native worker."""
from pathlib import Path
import json
import platform
import shutil
import subprocess
import sys
import venv

root = Path(__file__).resolve().parent.parent
arch = {"AMD64": "x64", "x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())
platform_name = {"darwin": "mac", "win32": "win"}.get(sys.platform, "linux")
runtime = root / "desktop-runtime" / f"{platform_name}-{arch}"
environment = runtime / "venv"
venv.EnvBuilder(with_pip=True).create(environment)
python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(root / "desktop/python-requirements.txt")], check=True)
subprocess.run([str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
                "--name", "xhs-python", "--distpath", str(runtime / "build"),
                "--workpath", str(runtime / "work"), "--specpath", str(runtime),
                "--paths", str(root), "--collect-data", "certifi",
                str(root / "desktop/python-worker.py")], cwd=root, check=True)
target = runtime / "python"
if target.exists():
    shutil.rmtree(target)
shutil.move(str(runtime / "build/xhs-python"), str(target))
executable = target / ("xhs-python.exe" if sys.platform == "win32" else "xhs-python")
health = subprocess.run([str(executable), "--health"], check=True, capture_output=True, text=True)
if not json.loads(health.stdout).get("ok"):
    raise RuntimeError("Bundled Python failed its health check")
(runtime / "build-info.json").write_text(json.dumps({"platform": sys.platform, "arch": platform.machine(),
                                                    "python": platform.python_version()}), encoding="utf-8")
print(f"Bundled Python ready: {executable}")
