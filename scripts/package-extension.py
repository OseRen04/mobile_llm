#!/usr/bin/env python3
"""Create a MV3 archive without source text or downloaded models."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

source = Path('dist/extension')
if not (source / 'manifest.json').is_file():
    raise SystemExit('Run npm run build:extension first.')
target = Path('dist/local-translator-extension.zip')
with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
    for item in sorted(source.rglob('*')):
        if item.is_file():
            archive.write(item, item.relative_to(source))
print(target)
