"""No-replace Linux rename, using inherited pinned directory descriptors only."""
import ctypes
import fcntl
import json
import os
import sys

moved = False
try:
    source, destination = sys.argv[1:]
    if any('/' in name or name in ('', '.', '..') for name in (source, destination)):
        raise ValueError('Invalid recovery name')
    if os.fstat(3).st_dev != os.fstat(4).st_dev:
        raise ValueError('Recovery requires the same filesystem')
    if os.environ.get('CARD_LOCK') == '1':
        fcntl.flock(5, fcntl.LOCK_EX | fcntl.LOCK_NB)
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    if rename(3, os.fsencode(source), 4, os.fsencode(destination), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    moved = True
    os.fsync(3)
    os.fsync(4)
    print(json.dumps({'moved': True, 'durable': True}))
except Exception as error:
    print(json.dumps({'moved': moved, 'durable': False, 'error': str(error)}))
    sys.exit(1)
