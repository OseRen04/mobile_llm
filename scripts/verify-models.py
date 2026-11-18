#!/usr/bin/env python3
"""Verify pinned OPUS assets and count original checkpoint tensor metadata.

Uses only Python's standard library. No arbitrary checkpoint code is executed.
Run --update-manifest only for an intentional, reviewed model update.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import collections
import hashlib
import io
import json
import math
from pathlib import Path
import pickle
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.model-audit'
MANIFEST = ROOT / 'packages/model-manager/src/model-manifest.json'
MODELS = {
    'toEnglish': {
        'id': 'Xenova/opus-mt-mul-en',
        'revision': '72a05e47cee89c718a9db4dc70d02fef3bc39de8',
        'label': '日本語・ロシア語 → 英語',
        'origin': 'Helsinki-NLP/opus-mt-mul-en',
        'originRevision': '848eae0c1676cfce9bb791c200e8228e5a6396ff',
    },
    'fromEnglish': {
        'id': 'Xenova/opus-mt-en-mul',
        'revision': 'e57f9759f8e1e9ed97067bfc11e53e1eab63e57e',
        'label': '英語 → 日本語・ロシア語',
        'origin': 'Helsinki-NLP/opus-mt-en-mul',
        'originRevision': '07ab277b060b29b7208dc0a198327eeeea92224d',
    },
}
FILES = [
    'config.json', 'generation_config.json', 'tokenizer.json',
    'tokenizer_config.json', 'special_tokens_map.json',
    'onnx/encoder_model_quantized.onnx',
    'onnx/decoder_model_merged_quantized.onnx',
]


def url(model, filename, origin=False):
    identifier = model['origin'] if origin else model['id']
    revision = model['originRevision'] if origin else model['revision']
    return f'https://huggingface.co/{identifier}/resolve/{revision}/{filename}'


def download_asset(model, filename):
    destination = CACHE / model['id'] / model['revision'] / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + '.partial')
        for attempt in range(3):
            try:
                with urllib.request.urlopen(url(model, filename), timeout=120) as response:
                    with temporary.open('wb') as stream:
                        while True:
                            block = response.read(1024 * 1024)
                            if not block:
                                break
                            stream.write(block)
                temporary.replace(destination)
                break
            except Exception:
                temporary.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(attempt + 1)
    digest = hashlib.sha256()
    with destination.open('rb') as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    result = {'path': filename, 'bytes': destination.stat().st_size, 'sha256': digest.hexdigest()}
    return result


def verify_upstream_metadata(model, assets):
    endpoint = f"https://huggingface.co/api/models/{model['id']}/revision/{model['revision']}?blobs=true"
    with urllib.request.urlopen(endpoint, timeout=120) as response:
        metadata = json.load(response)
    if metadata['sha'] != model['revision']:
        raise ValueError('Revision mismatch')
    siblings = {entry['rfilename']: entry for entry in metadata['siblings']}
    for asset in assets:
        upstream = siblings[asset['path']]
        if asset['bytes'] != upstream['size']:
            raise ValueError(f"Byte count mismatch: {asset['path']}")
        if 'lfs' in upstream:
            if asset['sha256'] != upstream['lfs']['sha256']:
                raise ValueError(f"LFS hash mismatch: {asset['path']}")
        else:
            data = (CACHE / model['id'] / model['revision'] / asset['path']).read_bytes()
            git_hash = hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
            if git_hash != upstream['blobId']:
                raise ValueError(f"Git blob hash mismatch: {asset['path']}")


class TensorMetadata:
    def __init__(self, storage, offset, size, stride, *_):
        self.storage = storage
        self.offset = offset
        self.size = tuple(size)
        self.stride = tuple(stride)


class MetadataUnpickler(pickle.Unpickler):
    """Only our inert constructors are exposed to the checkpoint."""
    def find_class(self, module, name):
        if (module, name) == ('collections', 'OrderedDict'):
            return collections.OrderedDict
        if (module, name) == ('torch._utils', '_rebuild_tensor_v2'):
            return TensorMetadata
        if module == 'torch' and name == 'FloatStorage':
            return 'float32'
        raise pickle.UnpicklingError(f'Forbidden checkpoint global: {module}.{name}')

    def persistent_load(self, identifier):
        if not isinstance(identifier, tuple) or identifier[0] != 'storage':
            raise pickle.UnpicklingError('Unexpected persistent identifier')
        return identifier


def count_parameters(model):
    destination = CACHE / model['origin'] / model['originRevision'] / 'checkpoint-header.bin'
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        request = urllib.request.Request(url(model, 'pytorch_model.bin', True), headers={'Range': 'bytes=0-131071'})
        with urllib.request.urlopen(request, timeout=120) as response:
            # Legacy torch checkpoint's entire tensor metadata fits in 128KiB.
            # Read only that bound even if a server ignores the Range request.
            data = response.read(131072)
        destination.write_bytes(data)
    data = destination.read_bytes()
    stream = io.BytesIO(data)
    for _ in range(3):
        MetadataUnpickler(stream).load()
    tensors = MetadataUnpickler(stream).load()
    unique = {}
    aliases = {}
    buffers = {}
    for name, tensor in tensors.items():
        if not isinstance(tensor, TensorMetadata):
            raise ValueError(f'Unexpected state value {name}')
        if name == 'final_logits_bias':
            buffers[name] = math.prod(tensor.size)
            continue
        key = (tensor.storage[2], tensor.offset, tensor.size, tensor.stride)
        aliases.setdefault(key, []).append(name)
        unique[key] = math.prod(tensor.size)
    parameters = sum(unique.values())
    if parameters > 400_000_000:
        raise ValueError('Model exceeds the 0.4B limit')
    report = {
        'origin': model['origin'], 'revision': model['originRevision'],
        'method': 'restricted-checkpoint-metadata; unique storage+offset+shape+stride; final_logits_bias excluded',
        'parameters': parameters, 'stateTensorCount': len(tensors),
        'uniqueParameterTensors': len(unique), 'buffersExcluded': buffers,
        'sharedParameters': [names for names in aliases.values() if len(names) > 1],
        'metadataBytesRead': len(data), 'metadataSha256': hashlib.sha256(data).hexdigest(),
    }
    (destination.parent / 'parameter-count.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--update-manifest', action='store_true')
    arguments = parser.parse_args()
    previous = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else None
    result = {}
    with ThreadPoolExecutor(max_workers=4) as executor:
        for key, model in MODELS.items():
            files = list(executor.map(lambda filename: download_asset(model, filename), FILES))
            verify_upstream_metadata(model, files)
            print(model['id'], 'verified', len(files), 'assets,', sum(asset['bytes'] for asset in files), 'bytes', flush=True)
            count = count_parameters(model)
            # MarianTokenizer removes a leading language tag before SentencePiece
            # tokenization, then prepends its vocabulary ID (not an added_token).
            tokenizer = json.loads((CACHE / model['id'] / model['revision'] / 'tokenizer.json').read_text())
            if key == 'fromEnglish':
                vocabulary = tokenizer['model']['vocab']
                tokens = {item[0]: index for index, item in enumerate(vocabulary)}
                for token in ('>>jpn<<', '>>rus<<'):
                    if token not in tokens:
                        raise ValueError(f'Missing target control token {token}')
                print('Target tokens:', {token: tokens[token] for token in ('>>jpn<<', '>>rus<<')}, flush=True)
            result[key] = {
                'key': key, 'id': model['id'], 'revision': model['revision'],
                'label': model['label'], 'parameters': count['parameters'],
                'license': 'Apache-2.0',
                'licenseUrl': f"https://huggingface.co/{model['origin']}/blob/{model['originRevision']}/README.md",
                'files': files, 'totalBytes': sum(item['bytes'] for item in files),
            }
    if arguments.update_manifest:
        MANIFEST.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        print('Updated', MANIFEST)
    elif previous != result:
        raise SystemExit('Manifest differs from verified bytes. Review differences before --update-manifest.')
    else:
        print('All pinned assets, parameter counts and target tokens verified.')


if __name__ == '__main__':
    main()
