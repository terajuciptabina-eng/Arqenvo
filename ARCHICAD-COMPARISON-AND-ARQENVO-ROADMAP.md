# Archicad Capability Audit & Integrated ARQENVO Blueprint

**Audit baseline:** ARQENVO main, 12 October 2026. This is a capability comparison and engineering plan, not a claim of feature parity.

## Executive finding

Archicad is a coordinated BIM workflow, not just a drawing canvas. It connects parametric building elements, model geometry, stories, derived views, documentation, schedules, collaboration, visualization and openBIM exchange.

ARQENVO is currently an early browser prototype with a schema-v2 model. The central gap is a tested geometry kernel and dependency/update graph that lets one authoritative model drive plan, 3D, quantities, sections, schedules and exports.

## Official research sources

- [Archicad product capabilities](https://www.graphisoft.com/en-fr/plans-and-products/archicad/)
- [Construction elements](https://help.graphisoft.com/AC/28/INT/_AC28_Help/040_ElementsVB/040_ElementsVB-2.htm)
- [Opening tool and host relationships](https://help.graphisoft.com/AC/28/INT/_AC28_Help/040_ElementsVB/040_ElementsVB-258.htm)
- [Interactive schedules](https://help.graphisoft.com/AC/28/INT/_AC28_Help/050_ViewsVB/050_ViewsVB-90.htm)
- [Documentation, layouts, revisions and publishing](https://help.graphisoft.com/AC/28/INT/_AC28_Help/070_Documentation/070_Documentation-1.htm)
- [Teamwork / BIMcloud](https://help.graphisoft.com/AC/28/INT/_AC28_Help/080_Collaboration/080_Collaboration-2.htm)
- [IFC and model/data exchange](https://help.graphisoft.com/AC/26/INT/_AC26_Help/121_IFC/121_IFC-1.htm)
- [Interoperability overview](https://help.graphisoft.com/AC/26/INT/_AC26_Help/120_Interoperability/120_Interoperability-1.htm)
- [Graphisoft 2026 product-line updates](https://www.graphisoft.com/en-re/plans-and-products/whats-new/)

Feature availability varies by version, subscription, regional offering and add-ons.

## A-to-Z capability comparison

Status key: **Basic** = early implementation; **Partial** = limited workflow; **Missing** = not implemented or not verified.

| Area | Mature Archicad workflow | ARQENVO now | Required target |
|---|---|---|---|
| Project setup | Project metadata, units, stories, views, templates and attributes | Partial: schema-v2, metric units, one default story | Project wizard, story manager, templates, attributes |
| 2D drafting | Precise selection, snaps, constraints, move/copy/rotate/trim/extend | Partial: canvas, grid, wall chain, axis constraint, basic select/dimension | Complete drafting state machine, snaps, keyboard entry and edit tools |
| Building elements | Walls, slabs, columns, beams, roofs, shells, meshes, stairs, railings, curtain walls, morphs and objects | Partial: walls/slabs/columns/beams; room detection | Parametric element contracts and shared geometry |
| Wall geometry | Profiles/composites, top/base constraints, joins and intersections | Partial: straight walls with thickness and height | Wall bodies, joins, intersection cleanup and constraints |
| Doors/windows/openings | Host-linked components, true model cuts, symbols and schedules | Partial: hosted data and plan markers; no true 3D cuts | Host-relative geometry, validation, real cuts and coordinated display |
| 3D | Editable parametric geometry, materials, stories and navigation | Partial: conceptual projection, not a solid engine | Geometry kernel and 3D generated from the authoritative model |
| Rooms/zones | Boundaries, area/volume, labels, criteria and schedules | Partial: endpoint-connected loops plus mid-wall segment splitting; complex topology still needs hardening | Topology-aware boundaries, net/gross area, volume and labels |
| Properties/classifications | IDs, typed properties, classification, IFC data and materials | Partial: basic dimensions/material field | Typed schema, classifications, custom properties and validation |
| Libraries/attributes | Building materials, composites, profiles, surfaces, objects and favorites | Missing/basic only | Attribute registry, object library, versioning/licensing |
| Multi-storey | Linked heights, home story and vertical relationships | Missing beyond default story | Story-aware geometry, base/top links and cross-story display |
| Views | Plans, 3D, sections, elevations, details, worksheets | Partial: plan and conceptual 3D; section/elevation previews only | Derived views with cut planes and visibility rules |
| Dimensions/annotation | Associative dimensions, labels, text, markers and graphic overrides | Partial: basic line dimension | Associative annotations, styles and label rules |
| Schedules/quantities | Criteria-based interactive schedules tied to model | Partial: core schedule function, no full UI | Filter/group/format/edit schedules and update model transactionally |
| Documentation/layouts | Layout book, linked drawings, revisions and publishing | Missing | Associative drawings, sheets, title blocks, revisions and PDF output |
| Collaboration | Teamwork, reservations, change tracking and BIMcloud | Missing | Later cloud service with access, conflicts and audit history |
| OpenBIM/IFC | IFC import/export, property mapping and coordination | Missing | IFC4 mapping, geometry/property round-trip tests, BCF issues |
| Other file exchange | DWG/DXF/PDF/point clouds/RVT/RFA workflows | Missing | Prioritize IFC, DXF/DWG and PDF reference workflows |
| Visualization | Materials, lighting, rendering and BIMx presentation | Missing beyond canvas projection | Materials and rendering after geometry is stable |
| Clash/issues | Model comparison, issue tracking and coordination | Missing | Geometry checks, viewpoints, issue states and BCF exchange |
| Energy/MEP | Connected analysis and discipline integrations | Missing | Scoped integrations after architectural core |
| Automation/API | Add-ons, scripting, parametric objects | Missing | Stable API only after model/events mature |
| Reliability/performance | Large models, recovery, team safety and mature QA | Partial: local file export/import and basic CI | Autosave/recovery, migration tests, regression and performance budgets |
| UX/accessibility | Customizable professional workspace and shortcuts | Prototype; precision and broad device support unverified | Complete shortcut map, accessible UI, desktop/tablet testing |

## Audited ARQENVO implementation

- `index.html`: browser shell, canvas, toolbar, navigator and properties panel.
- `src/app.js`: drawing interactions, multi-selection, undo/redo, basic parameter editing, opening placement, room detection and conceptual 3D.
- `src/core/model.js`: schema-v2 constructors, area calculations, serialization/migration and validation.
- `src/core/rooms.js`: room detection now splits walls at proper segment intersections before cycle detection and filters enclosing cycles when partition faces cover the full area; collinear overlaps, tolerance edge cases and complex networks still need broader regression coverage.
- `src/core/transactions.js`: initial pure services for atomic model edits, bounded undo/redo snapshots and downstream dependency invalidation. These services are unit-tested but are not yet the app-wide transaction/event pipeline; current UI still uses its existing local history handler.
- `tests/core.test.js`, `tests/rooms.test.js`: initial model/room tests; GitHub Actions runs CI.

Known gaps: no production solid geometry kernel; 3D walls are split into simple vertical intervals around openings but are not boolean-cut solids; near-tolerance junction handling and complex wall-network topology need broader validation; story selection exists but vertical constraints and cross-story coordination are incomplete; sections are data extraction rather than a fully rendered orthographic view; elevations, layout book, publishing, IFC, full DWG/DXF round-trip, object library and collaboration server remain incomplete. Multi-selection parameter editing exists for common dimensions/materials. Opening-property synchronization needs regression tests for all edge cases.

## Integrated architecture required

**One authoritative model; every output is derived from it.**

1. **Domain model:** project, buildings, stories, views/layouts, typed elements, stable IDs, properties, classifications, materials, layers, constraints and versioned migrations.
2. **Geometry/topology kernel:** coordinate and tolerance policy; wall bodies and joins; hosted opening cuts; validated polygons; room boundaries; quantity computation; revision-keyed geometry caches.
3. **Transaction and dependency graph:** every edit is one transaction. A wall change invalidates connected joins, openings, rooms, dimensions, schedules, sections/elevations and layout drawings. Undo/redo restores the complete transaction.
4. **View/document engine:** plans, 3D, sections and elevations from the same model; visibility/cut-plane settings; associative dimensions/labels; saved views; layout drawings, revisions and repeatable PDF publishing.
5. **Interoperability:** validated internal schema first; then IFC geometry/property round-trip tests, mapping configuration, BCF issues and DWG/DXF/PDF workflows.
6. **Reliability services:** local storage, autosave/recovery, migrations/backups, testable renderers, error reporting and performance budgets. Collaboration/cloud comes later without compromising local-first independence.

## Integrated delivery gates

### Gate 1 — Core integrity
Typed model contracts, stable IDs, units/tolerances, transactions, undo/redo, project recovery, migrations and save/open tests.

**Implementation started:** the standalone transaction/history/dependency services are committed and tested. The next integration step is to route UI edits through one transaction boundary and publish changed-node invalidations; do not mark Gate 1 complete until app integration, recovery and end-to-end regression tests pass.

### Gate 2 — Architectural geometry
Shared geometry for walls/slabs/columns/beams; wall joins/intersections; trim/extend; polygon validity; geometry tests for near misses and tolerances.

### Gate 3 — Hosted components and spaces
First-class hosted openings with real cuts; topology-aware room boundaries, area/volume and coordinated plan/3D/quantity updates.

### Gate 4 — Multi-storey coordination
Story elevations, base/top constraints, active-story plans and coordinated 3D.

### Gate 5 — Documentation
Associative dimensions/labels, real sections/elevations, interactive schedules, details, layouts, revisions and PDF publishing.

### Gate 6 — Interoperability and QA
IFC import/export with golden round-trip files, BCF, DWG/DXF/PDF reference workflows, performance and browser/device tests.

### Gate 7 — Extended ecosystem
Libraries/favorites, materials/rendering, clash/issues, optional MEP/energy integration, API and collaboration.

## Definition of done

A button is not proof a feature is complete. Each feature needs a data contract, validation/migration, unit tests and failure cases, an end-to-end UI workflow, save/open and undo/redo coverage, cross-view consistency, regression fixtures, a passing CI run and documented limitations.

## Conclusion

ARQENVO must be built as a coherent architectural modeling platform, not a set of disconnected look-alike tools. The first priority is a tested geometry and dependency core; then openings, rooms, stories, documentation and IFC can share one source of truth. Archicad-level parity is a substantial product effort and cannot honestly be claimed from the current prototype.

ARQENVO remains independent, retains its original logo, uses local-first project storage and remains separate from TerajuWorks and SunG Solution.

## Implementation log — 12 October 2026

The following increments have now been committed to `main`:

- Model validation checks story references, element geometry, positive dimensions, and host-wall opening bounds.
- The 3D preview draws extruded wall, slab, column and beam geometry; wall surfaces are split vertically around hosted opening intervals. This is still a lightweight canvas renderer, not a production solid/B-rep kernel.
- Multi-selection supports applying shared dimensions/materials to compatible selected elements.
- Canvas navigation supports space-drag or middle-mouse panning, grid placement and endpoint/vertex snapping.
- Local recovery snapshots are written after model-changing actions rather than every pointer redraw.
- Schedule CSV serialization has isolated tests for quoting, embedded line breaks, BOM and CRLF.
- Section extraction derives wall/slab/column/beam intersections from a section line and can export a cut-element schedule as CSV.
- Floor-plan DXF export writes supported 2D plan geometry on named layers in metre units. It does not export IFC semantics or editable 3D solids.
- A model-validation action is available in the toolbar.

### Verification status

Automated checks and GitHub Pages deployment run on each push. Verify the latest workflow result before considering the latest revision released. These features remain an early-stage implementation and have not yet passed cross-browser, mobile, large-project, professional drawing, or interoperability acceptance testing.

### Still required before a production-complete BIM product

1. Robust solid/boolean geometry, wall junction cleanup, wall thickness/joins, accurate opening-host editing and collision handling.
2. Parametric editing and transforms (move, rotate, mirror, copy, trim/extend), reliable undo/redo transactions and project-level validation.
3. Real orthographic sections/elevations with dimensioning, annotations, drawing layouts, title blocks, PDF plotting and revision management.
4. Proper IFC4 import/export with entity/property mapping and round-trip fixtures; DXF round-trip verification and additional exchange formats as justified.
5. Materials/surfaces, objects/components, stairs/roofs, zones/room schedules, quantity take-off and consistent dependent-view updates.
6. Accessibility, responsive mobile/tablet interactions, browser compatibility, large-model performance, backup/recovery tests and end-to-end user acceptance.
7. Persistence/security decisions for shared/team projects; current local autosave is browser-local and is not cloud collaboration.

**Release gate:** do not describe ARQENVO as feature-complete or Archicad-equivalent until these gaps are implemented, tested and explicitly accepted. The existing canvas 3D preview and DXF output are useful increments, not substitutes for a production BIM kernel or IFC exchange.


### Workspace UI increment — 12 October 2026

- Updated the application chrome to a coordinated professional BIM/CAD workspace: graphite menu strip, neutral command toolbar, dedicated toolbox, project navigator, central drawing tabs, story selector, right-side Info Box/settings and compact status line.
- Preserved the original ARQENVO logo and existing element/tool IDs to avoid breaking app event wiring.
- Responsive layouts now reduce side-panel footprint on smaller screens while retaining the drawing canvas and primary commands.
- This is a visual/workspace refinement only; menu labels are not yet full dropdown command systems, and unsupported tool families are deliberately not shown as if implemented.

**UI acceptance still required:** inspect live Pages on desktop and mobile, keyboard navigation/focus, panel overflow, canvas resizing, and real drawing/save/open workflows. Visual resemblance alone does not imply Archicad feature parity.


### 3D navigation increment — 12 October 2026

- Added camera state for yaw, pitch, zoom and pan to the 3D canvas projection.
- 3D left-drag orbits the camera; middle-mouse or Space-drag pans; wheel zooms independently from 2D plan zoom.
- Added standard camera actions: orbit left/right, top, front, home and fit model.
- Navigation is an initial interaction layer and still needs hands-on acceptance tests. Camera projection remains a lightweight canvas renderer; it is not a perspective-correct 3D viewport, and true model geometry, clipping, selection depth and production-grade orbit behavior remain open work.
- Latest Core Checks run for commit `eabaf49f`: https://github.com/terajuciptabina-eng/Arqenvo/actions/runs/38217750834 (check final result before release).
