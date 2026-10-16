"""Run pip with os.mkdir forced to a writable mode.

The DSH Windows file sandbox makes any directory created with mode 0o700
unwritable (``tempfile.mkdtemp`` uses 0o700), which breaks pip's unpack step:

    PermissionError: [Errno 13] Permission denied:
      ...\\pip-unpack-*\\...whl.metadata

``src/venv.ts`` always drives pip through this wrapper, inside the venv's own
interpreter, so the patch applies to the process that actually unpacks wheels.
Note that ``pip --python <other> install`` spawns a subprocess and therefore
bypasses the patch.
"""
import os
import runpy
import sys

_orig_mkdir = os.mkdir


def _mkdir(path, mode=0o777, **kwargs):
    return _orig_mkdir(path, 0o777, **kwargs)


os.mkdir = _mkdir
sys.argv = ["pip"] + sys.argv[1:]
runpy.run_module("pip", run_name="__main__", alter_sys=True)
