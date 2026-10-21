#!/usr/bin/env python3
"""PDF text extraction and structure validation for the literature pipeline.

This helper is deliberately separate from the Node plugin: PDF parsing and
RDKit validation are the only steps that need a Python environment. It writes
JSON files so the caller does not depend on console encoding.
"""

import argparse
import json
import re
import sys

import pymupdf
from rdkit import Chem, RDLogger
from rdkit.Chem import rdCoordGen
from rdkit.Chem import rdMolDescriptors
from rdkit.Chem import inchi

RDLogger.DisableLog("rdApp.*")


def write_json(path, value):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=1)


def extract_text(pdf_path, out_path):
    document = pymupdf.open(pdf_path)
    pages = []
    for index, page in enumerate(document):
        pages.append({"page": index + 1, "text": page.get_text("text")})
    write_json(out_path, {
        "pages": pages,
        "fullText": "\n\n".join(item["text"] for item in pages),
    })


def validate(smiles, out_path):
    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        raise SystemExit("RDKit could not parse the SMILES")
    write_json(out_path, {
        "formula": rdMolDescriptors.CalcMolFormula(molecule),
        "inchiKey": inchi.MolToInchiKey(molecule),
        "canonicalSmiles": Chem.MolToSmiles(molecule),
        "heavyAtoms": molecule.GetNumHeavyAtoms(),
    })


def coordgen(smiles, out_path):
    molecule = Chem.MolFromSmiles(smiles)
    if molecule is None:
        raise SystemExit("RDKit could not parse the SMILES")
    rdCoordGen.AddCoords(molecule)
    # Absolute stereo avoids ChemDraw's "&1" enhanced-stereo labels.
    molecule.SetProp("_MolFileChiralFlag", "1")
    Chem.MolToMolFile(molecule, out_path, kekulize=True)


def render(pdf_path, page_number, out_path, dpi):
    document = pymupdf.open(pdf_path)
    page = document[int(page_number) - 1]
    pixmap = page.get_pixmap(dpi=int(dpi))
    pixmap.save(out_path)
    write_json(out_path + ".json", {
        "width": pixmap.width,
        "height": pixmap.height,
        "page": int(page_number),
    })


def sdf_records(sdf_path, out_path):
    supplier = Chem.SDMolSupplier(sdf_path, removeHs=False, sanitize=True)
    records = []
    for molecule in supplier:
        if molecule is None:
            continue
        title = ""
        try:
            title = molecule.GetProp("_Name")
        except Exception:
            pass
        cas = ""
        for prop in molecule.GetPropNames():
            if "cas" not in prop.lower():
                continue
            match = re.search(r"\b\d{2,7}-\d{2}-\d\b", molecule.GetProp(prop))
            if match:
                cas = match.group(0)
                break
        records.append({
            "title": title,
            "cas": cas,
            "smiles": Chem.MolToSmiles(molecule),
            "formula": rdMolDescriptors.CalcMolFormula(molecule),
            "inchiKey": inchi.MolToInchiKey(molecule),
            "heavyAtoms": molecule.GetNumHeavyAtoms(),
        })
    if not records:
        raise SystemExit("The SDF contains no readable structures")
    write_json(out_path, {"records": records})


def clip(pdf_path, page_number, out_path, x0, y0, x1, y1, dpi):
    document = pymupdf.open(pdf_path)
    page = document[int(page_number) - 1]
    rect = None
    if all(value is not None for value in (x0, y0, x1, y1)):
        rect = pymupdf.Rect(float(x0), float(y0), float(x1), float(y1))
    pixmap = page.get_pixmap(dpi=int(dpi), clip=rect)
    pixmap.save(out_path)
    write_json(out_path + ".json", {
        "width": pixmap.width,
        "height": pixmap.height,
        "page": int(page_number),
    })


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    text_parser = subparsers.add_parser("text")
    text_parser.add_argument("pdf")
    text_parser.add_argument("out")

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("smiles")
    validate_parser.add_argument("out")

    coordgen_parser = subparsers.add_parser("coordgen")
    coordgen_parser.add_argument("smiles")
    coordgen_parser.add_argument("out")

    render_parser = subparsers.add_parser("render")
    render_parser.add_argument("pdf")
    render_parser.add_argument("page")
    render_parser.add_argument("out")
    render_parser.add_argument("--dpi", default="220")

    sdf_parser = subparsers.add_parser("sdf")
    sdf_parser.add_argument("sdf")
    sdf_parser.add_argument("out")

    clip_parser = subparsers.add_parser("clip")
    clip_parser.add_argument("pdf")
    clip_parser.add_argument("page")
    clip_parser.add_argument("out")
    clip_parser.add_argument("--box", nargs=4, type=float, default=None)
    clip_parser.add_argument("--dpi", default="300")

    args = parser.parse_args()
    try:
        if args.command == "text":
            extract_text(args.pdf, args.out)
        elif args.command == "validate":
            validate(args.smiles, args.out)
        elif args.command == "coordgen":
            coordgen(args.smiles, args.out)
        elif args.command == "render":
            render(args.pdf, args.page, args.out, args.dpi)
        elif args.command == "sdf":
            sdf_records(args.sdf, args.out)
        elif args.command == "clip":
            box = args.box or [None, None, None, None]
            clip(args.pdf, args.page, args.out, *box, args.dpi)
    except Exception as error:  # noqa: BLE001 - report a clean message to Node
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
