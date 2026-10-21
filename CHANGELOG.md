# Changelog

All notable changes to ChemDraw Bridge are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.1.0] - 2026-10-21

### Added

- `recognize_image`: OSRA structure recognition for a cropped figure image or a
  PDF page region, with RDKit validation of every SMILES candidate.
- `draw_reaction`: one-step reaction-scheme drafts from reactant/product SMILES,
  including arrow, conditions, yield and plus signs.
- SciFinder export import through `import_scifinder` (SDF preferred, CSV/TSV/TXT
  with CAS numbers also supported).
- `draw_from_identifier` accepts `SMILES:<smiles>` for structures that did not
  come from PubChem.
- Setup scripts for the non-committed runtime dependencies:
  `scripts/setup-python.ps1` and `scripts/setup-osra.ps1`.

### Changed

- Publication-style structure layout is now generated with RDKit CoordGen
  instead of ChemDraw's clipboard placement. This avoids tall, awkward layouts
  for large molecules.
- Standard drawing settings: Arial 9 pt labels, 0.4 cm bond length, 0.6 pt line
  width, 10 pt bond spacing and 1 pt margin.
- Reaction schemes use compact spacing, smaller arrowheads, 9 pt Arial
  conditions/yields and joined plus signs.
- README and Chinese manual now include installation, image recognition,
  reaction drafting and SciFinder export sections.

### Fixed

- SMILES element counter treated an aromatic atom after an uppercase atom (for
  example `Oc1...`) as a two-letter element; it now only accepts real two-letter
  symbols such as `Cl` and `Br`.
- CoordGen MOL files set the absolute chiral flag, which removes ChemDraw's
  `&1` enhanced-stereo labels from the drawing.
- Reaction and structure automation wait for and clean up only the ChemDraw
  processes started by the current call.

## [1.0.0] - 2026-10-21

### Added

- Initial ChemDraw Bridge plugin: CAS/name/CID lookup, fuzzy candidate search,
  paper/SI extraction, native `.cdxml`/`.cdx` output and composition validation.
