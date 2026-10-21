# Verification record

Generated on 2026-10-21 on the machine where the plugin is installed.

## Environment

- ChemDraw Professional 22.0.0.22 (ChemOffice 2022)
- RDKit 2026.09.1 (independent check, not a runtime dependency of the plugin)
- PubChem PUG REST as the structure source

## Method

For every compound below:

1. The plugin resolved the identity on PubChem and generated a `.cdxml` through ChemDraw.
2. The plugin's own check compared the CDXML element counts with the source SMILES and passed.
3. ChemDraw opened the generated CDXML and exported a `.mol`.
4. RDKit read that MOL with `Chem.MolFromMolFile(..., removeHs=False)` and computed `MolToInchiKey`.
5. The computed InChIKey was compared with the PubChem InChIKey stored in the sidecar JSON.

A match of the full InChIKey (including the stereo layer) means connectivity, bond orders, charges, isotopes and stereochemistry all survived the round trip.

## Result: 16/16 exact InChIKey matches

| Compound | CID | CAS | InChIKey | Note |
| --- | ---: | --- | --- | --- |
| Aspirin | 2244 | 50-78-2 | BSYNRYMUTXBXSQ-UHFFFAOYSA-N | CAS lookup |
| Caffeine | 2519 | 58-08-2 | RYYVLZVUVIJVGH-UHFFFAOYSA-N | fused N-heterocycle |
| Chloroform | 6212 | 67-66-3 | HEDRZPFGACZZDS-UHFFFAOYSA-N | halogen |
| Cholesterol | 5997 | 57-88-5 | HVYWMOMLDIMFJA-DPAQBDIFSA-N | 8 stereocentres, wedge/hash |
| Dimethyl sulfoxide | 679 | 67-68-5 | IAZDPXIOMUYVGZ-UHFFFAOYSA-N | S=O |
| L-Alanine | 5950 | 56-41-7 | QNAYBMKLOCPYGJ-REOHCLBHSA-N | one stereocentre |
| Pyridine | 1049 | 110-86-1 | JUJWROOIHBZHMG-UHFFFAOYSA-N | aromatic N |
| Sodium acetate | 517045 | 127-09-3 | VMHLLURERBWHNL-UHFFFAOYSA-M | salt, charges, two fragments |
| Atorvastatin | 60823 | 134523-00-5 | XUKUURHRXDUEBC-KAYWLYCHSA-N | 41 heavy atoms, 2 stereocentres |
| cis-Stilbene | 5356785 | 645-49-8 | PJANXHGTPQOBST-QXMHVHEDSA-N | Z double bond |
| trans-Stilbene | 638088 | 103-30-0 | PJANXHGTPQOBST-VAWYXSNFSA-N | E double bond |
| Acetaminophen | 1983 | 103-90-2 | RZVAJINKPMORJF-UHFFFAOYSA-N | name "Tylenol" |
| Acetic acid | 176 | 64-19-7 | QTBSBXVTEAMEQO-UHFFFAOYSA-N | name lookup |
| D-Glucose | 5793 | 50-99-7 | WQZGKKKJIJFFOK-GASJEMHNSA-N | name "glucose", 5 stereocentres |
| L-Ascorbic acid | 54670067 | 50-81-7 | CIWBSHSKHKDKBQ-JLAZNSOCSA-N | name "vitamin c" |
| Aspirin (CID input) | 2244 | 50-78-2 | BSYNRYMUTXBXSQ-UHFFFAOYSA-N | `CID:2244` path |

## Additional checks

| Case | Result |
| --- | --- |
| Water (7732-18-5) | `H2O` label, 1 heavy atom, 0 bonds, accepted |
| Methane (74-82-8) | `CH4` label, 1 heavy atom, 0 bonds, accepted |
| Ammonium chloride (12125-02-9) | `NH4+` and `Cl-` labels, accepted |
| Deuterium oxide (7789-20-0) | `D` labels preserved, accepted (warning about explicit D atoms) |
| Unicode output path | `E:\ds\化学结构 测试\tool 咖啡因.cdxml` generated and RDKit-verified; ChemDraw stages through an ASCII temp directory because its own `SaveAs` mangles non-ASCII paths |
| Ferrocene (102-54-5) | 10 C + Fe, rings and Fe drawn separately; no coordination bonds, manual editing recommended |
| Polyethylene (9002-88-4) | rejected: PubChem has no CAS record |
| Gasoline (8006-61-9) | rejected: PubChem has no CAS record |

## Negative checks

- `50-78-3` (wrong CAS check digit) → rejected before any network request; the message reports the expected digit `2`.
- `notacompoundxyz` → rejected; no file written.

## Literature extraction: DOI 10.1039/c7cc02426f

The SI PDF was downloaded from CaltechAUTHORS (the RSC PDF endpoint is behind
Cloudflare). The plugin located each compound's IUPAC name in the experimental
section, resolved it with OPSIN, and generated the ChemDraw file.

| Compound | Formula | InChIKey | SI HRMS | Result |
| --- | --- | --- | --- | --- |
| 3a | C27H19N3O4 | QWWIAFJZFCQLMC-ZEQRLZLVSA-N | C27H19N3O4 | exact |
| 5a | C22H20N2O5 | UCGNPBFEYVSMOX-IRXDYDNUSA-N | C22H20N2O5Na | Na adduct normalized |
| 6a | C23H24N2O6 | KWJQIHWFBQBREO-MSOLQXFVSA-N | C23H24N2O6Na | Na adduct normalized |

Each generated CDXML was reopened in ChemDraw and exported to MOL; RDKit then
recomputed the InChIKey. All three matched the OPSIN InChIKey exactly.

The paper's scheme uses abbreviated labels (`PhthN`, `MQ`), so pure image OCR
cannot reconstruct these structures. The IUPAC name in the SI is the reliable
source; the tool refuses image-only compounds instead of guessing.

## Fuzzy search and selection

`search_compounds` is backed by PubChem autocomplete plus ChemicalBook and
prefix probes for common typos.

| Query | Top candidate | Result |
| --- | --- | --- |
| `aspirin` | Aspirin, CID 2244 | exact, no selection |
| `asprin` | Aspirin, CID 2244 (93%) | selection list; second candidate is a different CID |
| `caffiene` | Caffeine, CID 2519 (94%) | selection list |
| `阿司匹林` | Aspirin, CID 2244 | selection list via ChemicalBook |
| `glucose` | D-Glucose, CID 5793 | exact, no selection |

`draw_from_identifier` refuses to draw an ambiguous name; it returns the
candidate list and asks the caller to use `search_compounds`. After the operator
chooses, `draw_from_identifier` is called with the chosen `CID:<cid>`. CAS and
explicit CID inputs bypass fuzzy matching.

SciFinder has no public API and requires a subscription; it is not scraped.
PubChem and ChemicalBook are the supported search sources.

## SciFinder export import

SciFinder's web API is OAuth/ELN-oriented and returns a path into its web app,
not the result set. The plugin therefore reads the export a logged-in user
downloads.

A synthetic SDF (Aspirin, CAS 50-78-2, C9H8O4) and a CSV with the same CAS were
used to exercise the path:

- SDF → RDKit → candidate `SMILES: CC(=O)Oc1ccccc1C(=O)O` → `draw_from_identifier(identifier="SMILES:...")` → 13/13 heavy atoms, CDXML verified.
- CSV → PubChem CID 2244 → candidate with SMILES and CID.
- A live SciFinder export was not available in this environment; SDF is the
  recommended format because it carries the authoritative structure.

## Image recognition and reaction drafts

- `recognize_image` on a ChemDraw-rendered aspirin PNG returned one candidate,
  `C9H8O4`, SMILES `CC(=O)Oc1ccccc1C(=O)O`; RDKit parsed it and computed the
  formula.
- `draw_reaction(reactants=["CCO"], products=["CC=O"], conditions="Pd(OAc)2, 80 °C", yield_text="82%")`
  produced a one-step scheme with the arrow, conditions and yield; ChemDraw
  reopened the generated CDXML and exported both CDX and PNG.

Limitations: OSRA is a candidate generator. Abbreviated groups (`PhthN`, `MQ`,
`Boc`) and low-resolution figures are not reconstructed; the operator must
review the SMILES before drawing.

## Publication layout

The layout pipeline now uses RDKit CoordGen, then ChemDraw applies Arial 9 pt
labels, 20 pt (0.4 cm) bonds, 0.6 pt lines and compact reaction spacing.

- 3a: old clipboard layout was 719 x 1293 px (tall/narrow); CoordGen layout is
  1181 x 765 px, with the phthalimide, β-lactam and quinoline units spread
  horizontally.
- Aspirin, cholesterol and the 3a/5a/6a samples were regenerated with the new
  settings; CDXML atom counts and InChIKeys are unchanged.
- The chiral flag is written into the CoordGen MOL so ChemDraw does not add
  `&1` enhanced-stereo labels.

## Reaction caption centering

ChemDraw CDXML captions use `p` as the left edge, not the center. The first
version placed conditions at the arrow center, so the text extended to the
right. The current writer subtracts half of the estimated text width and
supports newline-separated condition lines; the sample conditions and yield are
centered above/below the arrow.

## Fig. 2 correction

The previous Fig. 2 interpretation omitted the alpha-CH2 next to the carbonyl.
The corrected substrate is `PhthN-CH2-CO-NH-MQ` (C20H15N3O4) and the product is
`PhthN-CH(Ar)-CO-NH-MQ` (C26H19N3O4 for Ar = Ph). It is saved as
`E:\ds\chemdraw\Fig2_row1_corrected.cdxml/.cdx/.png`.

`recognize_image` now accepts `expected_formula`; a candidate whose formula
differs is rejected, which catches a missing or extra carbon before drawing.

## Reproduce

```powershell
# Generate
node tools/cli.mjs "57-88-5" --out "E:\ds\chemdraw-test\set" --name cholesterol --cdx

# Export the generated CDXML to MOL through ChemDraw, then:
python -m pip install rdkit
python tools\verify-rdkit.py <mol-dir> <meta-dir>
```

RDKit is used both for CoordGen layout and this verification; `scripts/setup-python.ps1` installs PyMuPDF and RDKit.
