"""Shared isolated data directory, initialized before any application import."""
import atexit
import os
import tempfile

DATA = tempfile.TemporaryDirectory(prefix='dingpan-tests-')
os.environ['DINGPAN_DATA_DIR'] = DATA.name
atexit.register(DATA.cleanup)
