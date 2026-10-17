"""Model-free fake public API, installed only in temporary test directories."""
import json
import os
from pathlib import Path
import struct
import sys
import zipfile
from types import SimpleNamespace


def log(action, **values):
    target = Path(os.environ['HF_HOME']) / 'calls.jsonl'
    with target.open('a') as stream:
        stream.write(json.dumps({'action': action, **values}) + '\n')


def side_effects():
    mode = os.environ.get('FAKE_PROVIDER_MODE')
    if mode == 'grammar-extract':
        # Real 0.7.0 extracts a ~456 KiB tree-sitter library into the redirected library cache.
        target = Path(os.environ['SEMBLE_GRAMMARS_CACHE_DIR']) / 'macos-arm64'
        target.mkdir(parents=True, exist_ok=True)
        (target / 'libtree_sitter_javascript.dylib').write_bytes(b'g' * 466944)
    if mode == 'library-overflow':
        (Path(os.environ['TMPDIR']) / 'blob').write_bytes(b'b' * 70000)
    if mode == 'tmp-churn':
        # Python tempfile/filelock probes: files appear and vanish while the parent walks the sandbox.
        import time
        stop = time.time() + 0.4
        n = 0
        while time.time() < stop:
            probe = Path(os.environ['TMPDIR']) / f'probe-{n}'
            probe.write_bytes(b'p')
            probe.unlink()
            n += 1


def npy(descr, values):
    # numpy .npy v1: magic, header dict padded to 64 bytes, raw little-endian values.
    header = repr({'descr': descr, 'fortran_order': False, 'shape': (len(values),)})
    header += ' ' * ((64 - (10 + len(header) + 1) % 64) % 64) + '\n'
    body = bytes(values) if descr == '|u1' else struct.pack('<%d%s' % (len(values), 'q' if descr == '<i8' else 'i'), *values)
    return b'\x93NUMPY\x01\x00' + struct.pack('<H', len(header)) + header.encode() + body


def save_bm25(target, ids):
    # The layout numpy.savez writes for Semble 0.7.0: a stored zip with zip64 local extras, members in this order.
    packed = lambda strings: list(('\0'.join([*strings, ''])).encode())
    members = {'doc_order': npy('|u1', packed(ids)), 'terms': npy('|u1', packed(['term'])), 'offsets': npy('<i8', [0, len(ids)]),
               'docs': npy('<i4', list(range(len(ids)))), 'tfs': npy('<i4', [1] * len(ids)), 'doc_lengths': npy('<i4', [1] * len(ids))}
    with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, data in members.items():
            with archive.open(name + '.npy', 'w', force_zip64=True) as member:
                member.write(data)


class SembleIndex:
    def __init__(self, chunks, root, model):
        self.chunks = chunks
        self.root = root
        self.model = model
        self.stats = SimpleNamespace(total_chunks=len(chunks))

    @classmethod
    def from_path(cls, root, *, model_path, content, show_progress_bar):
        log('from_path', root=str(root), model=model_path, content=[c.value for c in content], progress=show_progress_bar)
        side_effects()
        chunks = []
        for file in sorted(root.rglob('*')):
            if file.is_file():
                chunks.append({'file_path': str(file.relative_to(root)), 'start_line': 1, 'end_line': 1, 'content': file.read_text(), 'language': 'python'})
        return cls(chunks, str(root), model_path)

    @classmethod
    def load_from_disk(cls, index):
        log('load', index=str(index))
        side_effects()
        if os.environ.get('FAKE_PROVIDER_MODE') == 'network':
            import socket
            socket.create_connection(('example.com', 443))
        if os.environ.get('FAKE_PROVIDER_MODE') == 'outside-write':
            Path(os.environ['FAKE_OUTSIDE_PATH']).write_text('denied')
        if os.environ.get('FAKE_PROVIDER_MODE') == 'sleep':
            import time
            time.sleep(2)
        if os.environ.get('FAKE_PROVIDER_MODE') == 'stats-overflow':
            (Path(os.environ['SEMBLE_CACHE_LOCATION']) / 'savings.jsonl').write_bytes(b'x' * 70000)
        metadata = json.loads((index / 'metadata.json').read_text())
        return cls(json.loads((index / 'chunks.json').read_text()), metadata['root_path'], metadata['model_path'])

    def search(self, query, *, top_k, alpha, rerank):
        log('search', top_k=top_k, alpha=alpha, rerank=rerank)
        # Deliberately reverse provider output; adapter must preserve this rank order.
        return [SimpleNamespace(chunk=SimpleNamespace(**chunk), score=1.0) for chunk in reversed(self.chunks)]

    def save(self, target):
        log('save', path=str(target))
        if os.environ.get('FAKE_PROVIDER_MODE') == 'fail-save':
            raise ValueError('private failure')
        target.mkdir(parents=True)
        (target / 'bm25_index').mkdir()
        (target / 'semantic_index').mkdir()
        files = {c['file_path']: {'mtime_ns': (Path(self.root) / c['file_path']).stat().st_mtime_ns, 'start': i, 'count': 1} for i,c in enumerate(self.chunks)}
        (target / 'metadata.json').write_text(json.dumps({'root_path': self.root, 'model_path': self.model, 'cache_version': 2, 'chunk_size': 750, 'content_type': ['code'], 'files': files, 'time': __import__('time').time()}))
        (target / 'chunks.json').write_text(json.dumps(self.chunks))
        ids = [f'{c["file_path"]}:0' for c in self.chunks]
        save_bm25(target / 'bm25_index' / 'index.npz', ids)
        (target / 'semantic_index' / 'arguments.json').write_text('{"metric":"cosine"}')
        header = repr({'descr': '<f4', 'fortran_order': False, 'shape': (len(self.chunks), 2)})
        header += ' ' * ((64 - (10 + len(header) + 1) % 64) % 64) + '\n'
        (target / 'semantic_index' / 'vectors.npy').write_bytes(b'\x93NUMPY\x01\x00' + struct.pack('<H',len(header)) + header.encode() + b'\0' * (len(self.chunks) * 8))


if __name__ == '__main__':
    dest = Path(sys.argv[1]); (dest / 'semble').mkdir(parents=True)
    (dest / 'semble' / '__init__.py').write_text('')
    (dest / 'semble' / 'index.py').write_text(Path(__file__).read_text())
    (dest / 'semble' / 'types.py').write_text('from enum import Enum\nclass ContentType(str, Enum):\n    CODE = "code"\n')
    metadata = dest / 'semble-0.7.0.dist-info'; metadata.mkdir()
    (metadata / 'METADATA').write_text('Name: semble\nVersion: 0.7.0\n')
    for package in ('numpy', 'model2vec', 'tokenizers', 'huggingface-hub', 'safetensors', 'vicinity'):
        metadata = dest / (package.replace('-', '_') + '-1.0.dist-info'); metadata.mkdir()
        (metadata / 'METADATA').write_text(f'Name: {package}\nVersion: 1.0\n')
