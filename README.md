# ChemDraw Bridge

A DeepSeek Harness plugin that bridges **compound identity** and **literature structures** to native, editable ChemDraw source files on this computer.

It accepts a CAS number, an English/IUPAC compound name, or a compound in a paper/SI PDF.

中文操作说明：[README.zh.md](./README.zh.md)

## What it produces

- `"<title> (CID <cid>).cdxml"` — ChemDraw's native XML format. Double-click to open and edit in ChemDraw.
- `"<title> (CID <cid>).cdx"` — optional binary ChemDraw format, useful when inserting an OLE object into Word. Enable with `also_cdx: true`.
- `"<title> (CID <cid>).meta.json"` — provenance: PubChem CID, CAS, formula, InChIKey, SMILES, generation time, ChemDraw version and the validation result.

The `.cdxml` file is written by ChemDraw itself, not hand-authored: the plugin pastes the PubChem isomeric SMILES into a hidden ChemDraw document and saves that document. ChemDraw therefore supplies the layout, implicit hydrogens, charges and stereo wedges.

## How identity is resolved

1. **CAS number** (e.g. `50-78-2`): the check digit is validated locally. PubChem is queried, and the returned CID is accepted only if the exact CAS string appears in that CID's synonym list. A bad check digit or an unconfirmed CAS is rejected rather than guessed.
2. **Name** (e.g. `aspirin`, `L-ascorbic acid`): PubChem autocomplete and ChemicalBook are searched, with prefix probes for common typos. One exact match is used directly; multiple candidates require the operator to select one before generation.
3. **CID** (`CID:2244` or a bare integer): used directly.

Chinese names are resolved through ChemicalBook when possible; CAS remains the most reliable input.

## Fuzzy names and operator selection

A name does not have to be exact:

1. PubChem autocomplete supplies name suggestions, and a few shorter prefixes are probed to catch common typos (`caffiene` → `caffeine`, `asprin` → `aspirin`).
2. ChemicalBook is searched as a secondary, best-effort source; it has no public API and is skipped when unavailable.
3. If one exact match is found, it is drawn directly.
4. If several candidates remain, `draw_from_identifier` returns the ranked list and asks the caller to use `search_compounds`; the operator chooses one, then the caller invokes `draw_from_identifier` with `CID:<cid>`.

CAS numbers and explicit CIDs never go through fuzzy matching.

SciFinder's search API is OAuth/ELN-oriented and returns a path into its web application rather than the result set. The precise route is the export workflow below; PubChem and ChemicalBook remain the fuzzy-search sources.

## SciFinder exports

A logged-in SciFinder user can export the selected substance records and let the plugin read them:

1. In SciFinder, search for the substance, select the target record(s), and export **SDF** (preferred, carries the authoritative structure) or **CSV/TSV** with CAS numbers.
2. Call `import_scifinder(file_path="...")`.
3. The tool returns candidates; the operator chooses one.
4. Draw it with `draw_from_identifier(identifier="SMILES:<smiles>")`, or with `CID:<cid>` when the CSV row resolved to PubChem.

Supported export formats: `.sdf`, `.csv`, `.tsv`, `.txt`. SDF is read with RDKit and compared with the CDXML after ChemDraw writes it, so the structure does not depend on a name lookup.

## Literature extraction

`draw_from_paper` extracts a compound from a paper or its supporting information:

1. It reads the PDF text and locates the requested label (for example `3a`) and the IUPAC name printed above it.
2. It resolves that name with the public **OPSIN** name-to-structure service.
3. **RDKit** independently computes the formula and InChIKey; a mismatch is a hard failure.
4. If the SI also prints an HRMS formula (for example `calc. for C27H19N3O4`), the formula is cross-checked, allowing for common `Na`/`K`/`Li` adducts.
5. ChemDraw writes the `.cdxml` / optional `.cdx`.

A real example from `10.1039/c7cc02426f` (compound `3a`):

```text
PDF text  ->  2-((3S,4S)-1-(5-Methoxyquinolin-8-yl)-2-oxo-4-phenylazetidin-3-yl)isoindoline-1,3-dione
OPSIN     ->  COC1=C2C=CC=NC2=C(C=C1)N1C([C@H]([C@@H]1C1=CC=CC=C1)N1C(C2=CC=CC=C2C1=O)=O)=O
RDKit     ->  C27H19N3O4, InChIKey QWWIAFJZFCQLMC-ZEQRLZLVSA-N
HRMS      ->  C27H19N3O4  (match)
```

`source` may be a DOI, a PDF URL, or a local PDF path. Publishers often block automated PDF downloads; in that case pass `local_pdf` with a PDF/SI you downloaded yourself. The DOI is still used for the citation metadata.

The tool refuses to guess when no unambiguous IUPAC name is found. Abbreviated schemes (`PhthN`, `MQ`, `Boc` as labels) cannot be reconstructed by image OCR alone, so a name is the reliable route.

## Verification

Before returning, the plugin:

- parses the generated CDXML and compares its element counts with the source SMILES;
- checks that the heavy-atom count matches;
- checks that fragments and bonds exist;
- checks the `VjCD0100` header when a `.cdx` is requested;
- writes the result into the sidecar JSON.

If the atom composition does not match, the generated files are deleted and the call fails.

## Install

1. Clone or download this repository to a local folder.
2. Run the Python setup once (needed by `draw_from_paper` and `import_scifinder`):

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\setup-python.ps1
   ```

3. In DeepSeek Harness, install that folder as a bundle:

   ```text
   plugin_manager install_bundle(target="E:\\path\\to\\chemdraw-bridge")
   ```

4. Enable the `chemdraw-bridge` plugin row if it is not already active.

The `vendor/venv` directory is intentionally not committed; `scripts/setup-python.ps1` creates it.

## Requirements

- Windows with ChemDraw installed and activated (tested with ChemOffice 2022 / ChemDraw 22.0.0.22).
- Network access to `pubchem.ncbi.nlm.nih.gov` and `www.chemicalbook.com`; the literature tool also uses `opsin.ch.cam.ac.uk`.
- No API key.

## Tool

`search_compounds`

| Parameter | Meaning |
| --- | --- |
| `query` | Compound name or partial name (`asprin`, `vitamin c`, `阿司匹林`). Required. |
| `limit` | Maximum candidates, 3–8; default 6. |

Returns ranked candidates with CID, CAS, formula, source and match score. Show them to the operator, then call `draw_from_identifier` with the chosen `CID:<cid>`.

`import_scifinder`

| Parameter | Meaning |
| --- | --- |
| `file_path` | SciFinder export: `.sdf` (preferred), `.csv`, `.tsv` or `.txt`. Required. |
| `query` | Optional name used to label/score the candidates. |
| `limit` | Maximum candidates, 1–20; default 10. |

For an SDF record, call `draw_from_identifier` with `SMILES:<smiles>`; for a CSV row that resolved to PubChem, `CID:<cid>` also works.

`draw_from_identifier`

| Parameter | Meaning |
| --- | --- |
| `identifier` | CAS number, English/IUPAC name, `CID:<number>`, or `SMILES:<smiles>`. Required. |
| `output_dir` | Output directory. Defaults to `<session working directory>\chemdraw`. |
| `file_name` | Base file name without extension. Defaults to `<title> (CID <cid>)`. |
| `also_cdx` | Also write the binary `.cdx`. Default `false`. |
| `overwrite` | Overwrite instead of adding `(2)`, `(3)` ... Default `false`. |
| `auto_select` | Take the highest-scoring fuzzy candidate without asking. Default `false`. |

Config keys in `cordis.patch.yml` are `outputDir`, `alsoCdx`, `timeoutMs` and `pythonPath`.

`draw_from_paper`

| Parameter | Meaning |
| --- | --- |
| `source` | DOI, direct PDF URL, or local PDF path. Required. |
| `compound` | Label as printed (`3a`, `compound 7`), a full IUPAC name, or a known name/CAS. Required. |
| `local_pdf` | Local paper/SI PDF. Used first; needed when the DOI PDF is blocked. |
| `output_dir`, `file_name`, `also_cdx`, `overwrite` | Same meaning as above. |

The literature and SciFinder import paths need a Python environment with PyMuPDF and RDKit. On a fresh clone, run this once:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-python.ps1
```

It creates `vendor/venv` and installs `requirements.txt`. OPSIN is called over HTTPS at `https://opsin.ch.cam.ac.uk`; no API key is needed.

## Command line

The bundled CLI runs the same pipeline:

```powershell
node tools/cli.mjs "50-78-2" --out "E:\ds\chemdraw"
node tools/cli.mjs "cholesterol" --cdx
node tools/cli.mjs "CID:2244" --name aspirin
```

## Implementation notes

- `lib/pubchem.js` — PUG REST client and strict identifier resolution.
- `lib/literature.js` — PDF text, label/name extraction, OPSIN and RDKit checks.
- `lib/generate.js` — shared SMILES → ChemDraw → CDXML validation step.
- `scripts/pdf_tool.py` — PyMuPDF text extraction and RDKit formula/InChIKey validation.
- `lib/smiles.js` — small atom counter used only for validation.
- `lib/cdxml.js` — CDXML reader and element-composition comparison.
- `lib/chemdraw.js` — PowerShell/COM bridge with serialization, timeout and output checks. ChemDraw's `SaveAs` is unreliable with non-ASCII paths, so it always writes into an ASCII staging directory and Node moves the finished files to the requested path.
- `scripts/convert.ps1` — opens a hidden ChemDraw document, pastes the SMILES, saves CDXML/CDX, restores the clipboard.

Only one conversion runs at a time because ChemDraw automation and the clipboard are process-global. The tool is marked non-concurrency-safe.

## Limitations

- Structures come from PubChem's canonical isomeric SMILES (identifier tool) or from the paper's IUPAC name via OPSIN (literature tool). A record without a SMILES, and a paper without an IUPAC name, cannot be drawn reliably.
- Image-only figures are rejected rather than guessed. Abbreviated schemes (PhthN, MQ, Boc labels) cannot be reconstructed from pixels alone.
- Organometallic coordination bonds are not inferred by ChemDraw's SMILES paste. Ferrocene, for example, arrives as two cyclopentadienyl rings plus a separate Fe atom; add the dative bonds manually if the figure needs them.
- The drawing is ChemDraw's automatic layout of that SMILES. It is chemically correct and editable, but a human may still prefer to clean up ring angles or add publication styling.
- If ChemDraw is already open, the plugin attaches to that instance and closes only the document it created. It does not quit the user's session.
- A name that is ambiguous in PubChem is rejected with candidate CIDs instead of silently choosing one.
