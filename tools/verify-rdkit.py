#!/usr/bin/env python3
"""Optional independent check: compare ChemDraw-exported MOL files with PubChem InChIKeys.

This is not used by the plugin at runtime. It requires RDKit:

    python -m pip install rdkit

Usage:
    python tools/verify-rdkit.py <mol-dir> <meta-dir>

Each <name>.mol must have a matching <name>.meta.json in <meta-dir>, as written
by draw_from_identifier or draw_from_paper. The MOL is exported from the
generated CDXML by ChemDraw.
"""

import glob
import json
import os
import sys

from rdkit import Chem, RDLogger
from rdkit.Chem import inchi

RDLogger.DisableLog("rdApp.*")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    mol_dir, meta_dir = sys.argv[1], sys.argv[2]
    ok = 0
    fail = 0
    for mol_path in sorted(glob.glob(os.path.join(mol_dir, "*.mol"))):
        base = os.path.splitext(os.path.basename(mol_path))[0]
        meta_path = os.path.join(meta_dir, base + ".meta.json")
        if not os.path.exists(meta_path):
            print("NO META", mol_path)
            fail += 1
            continue
        with open(meta_path, encoding="utf-8") as handle:
            meta = json.load(handle)
        expected = meta["compound"]["inchiKey"]
        mol = Chem.MolFromMolFile(mol_path, removeHs=False, sanitize=True)
        if mol is None:
            print("PARSE FAIL", mol_path)
            fail += 1
            continue
        actual = inchi.MolToInchiKey(mol)
        if actual == expected:
            ok += 1
            print("OK  ", base, actual)
        else:
            fail += 1
            print("DIFF", base, "expected", expected, "got", actual)
            print("     smiles:", Chem.MolToSmiles(mol))
    print(f"RESULT ok={ok} fail={fail}")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
