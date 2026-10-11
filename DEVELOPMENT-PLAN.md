# ARQENVO — Development Plan

ARQENVO is an independently implemented architectural CAD/BIM application. The target is an Archicad-inspired professional workflow, not a literal copy of Graphisoft source code, proprietary assets, or protected implementation.

## Development principles
- Keep ARQENVO independent: separate repository, code, project files, and deployment. No connection to TerajuWorks or TerajuEnergy/SunG Solution.
- Architecture-first: one model drives plan, 3D, sections/elevations, schedules and documentation.
- Metric units and local-first project files by default.
- Every feature must have a testable acceptance criterion. Never describe a preview as a finished BIM feature.
- IFC interoperability comes after model integrity and regression tests.

## Milestone 0.3 — BIM data foundation (in progress)
- [x] Introduce schema v2 project structure: project metadata, stories, settings, elements and views.
- [x] Typed constructors for walls, slabs, columns and beams.
- [x] Host-wall opening model for doors/windows.
- [x] Gross/net wall area, polygon area/perimeter and element schedule calculations.
- [x] v1 project migration and validation/serialization helpers.
- [x] Automated unit tests for core geometry, model validation, serialization and migration.
- [ ] Connect the new model to the interactive UI (current UI still uses legacy arrays).
- [ ] Wall joining and room boundary detection.
- [ ] True parametric 3D geometry and openings.

## Roadmap
1. **Core model:** stable element IDs, stories, layers, materials, properties, undo/redo commands and project migrations.
2. **2D authoring:** robust snapping, wall chains/joins, polygonal slabs, columns, beams, hosted doors/windows, dimensions, labels and multi-select editing.
3. **Rooms and quantities:** closed-boundary detection, room stamps, net/gross areas, schedules and change-aware updates.
4. **3D BIM:** parametric geometry generated from the same model, wall/slab/roof joins, real door/window voids, orbit/pan/section box.
5. **Building design:** roofs, stairs, railings, curtain walls, objects, terrain and story management.
6. **Documentation:** sections/elevations, markers, detail views, layouts, title blocks, drawing links, revisions, PDF publishing and schedules.
7. **Interoperability:** IFC import/export and later validated exchange workflows.
8. **Product hardening:** performance, accessibility, keyboard workflows, autosave/recovery, compatibility, regression suite and desktop packaging assessment.

## Current truth
This is staged development, not yet feature parity with Archicad. The existing public UI remains a prototype until the new core is integrated and end-to-end interaction tests pass.
