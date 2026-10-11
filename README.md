# ARQENVO — Architectural CAD/BIM

ARQENVO is an independently developed architectural CAD/BIM application with an Archicad-inspired workflow. It does not use Graphisoft's proprietary source code or assets and remains separate from TerajuWorks and TerajuEnergy/SunG Solution.

## Live browser prototype
https://terajuciptabina-eng.github.io/Arqenvo/

## Development status

**Active staged development — not yet equivalent to Archicad.** The current public UI is still the original prototype; new core modules are being built and tested before integration into the authoring interface.

### Existing browser UI
- 2D floor-plan canvas, connected wall-chain tool, grid and axis constraint.
- Basic selection, undo/redo, zoom/pan and local `.arq` export/import.
- Conceptual 3D preview generated from wall coordinates.
- Original ARQENVO logo asset.

### Core milestone 0.3
- Project schema v2: project metadata, stories, settings, views and typed elements.
- Wall/slab/column/beam model constructors with dimensional validation.
- Door/window/opening host-wall data model.
- Gross/net wall areas, polygon area/perimeter and element quantity schedule.
- Legacy v1 project migration, serialization and schema validation.
- First-pass room boundary detection for endpoint-connected closed wall loops.
- Node test suite and GitHub Actions checks.

### Known limitations
The new model and room detector are **not yet connected to the public UI**. Room detection currently supports endpoint-connected loops; intersections in the middle of a wall are not automatically split. The existing UI still stores legacy arrays and its slab/door/window/beam tools are incomplete. Production-quality parametric 3D, actual wall joins and opening voids, roofs, stairs, object libraries, sections/elevations, layouts, publishing, IFC, desktop packaging and full parity are not implemented.

## Planned development order
1. Integrate the core model and schema migration with the current UI.
2. Robust 2D drafting: snaps, wall joins, polygonal slabs, beams/columns, hosted doors/windows, multi-selection and editable properties.
3. Closed room boundaries, room labels, area calculations and schedules.
4. Parametric 3D generated from the same model, with real openings and story elevations.
5. Roofs, stairs, railings, curtain walls, object library and terrain.
6. Sections/elevations, details, layouts, drawing links, revisions, PDF publishing and schedules.
7. IFC interoperability after model integrity and regression coverage.
8. Performance, recovery, accessibility, broad browser/device testing and desktop packaging assessment.

## Principles
- Architectural workflow first; no Revit-based product direction.
- One authoritative building model drives plan, 3D, sections and schedules.
- Metric units and local project files by default.
- Test features before claiming they work; label previews and incomplete tools honestly.
- Independent code, assets, data and deployment. No integration with TerajuWorks or SunG Solution.

## Local checks
```sh
npm test
npm run check
```
