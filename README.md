# ARQENVO — Architectural Studio

ARQENVO is a standalone architectural CAD/BIM prototype, developed independently from TerajuWorks and TerajuEnergy/SunG Solution.

## Open the live app
After GitHub Pages finishes publishing, open:
https://terajuciptabina-eng.github.io/Arqenvo/

## Current browser prototype
- Architectural-style light/neutral workspace with Toolbox, Navigator, drawing canvas and Info Box.
- Draw connected wall chains with click points; press Escape or double-click to finish.
- Hold Shift to constrain wall direction to the nearest horizontal/vertical axis.
- Basic wall, column and dimension tools; conceptual 3D projection from the same wall coordinates.
- Select elements, undo/redo, zoom/pan, export and reopen a local .arq project file.
- No project file is uploaded automatically; save/open are local browser actions.

## Important limitations
This is a prototype scaffold, not an Archicad replacement and not yet equivalent to Archicad. Slabs, openings, beams, section/elevation, Story Settings, library objects, real BIM properties, layouts, publishing and production-grade 3D geometry are incomplete or not implemented. IFC remains intentionally out of scope until the core authoring and regression tests are complete.

## Data and separation
The prototype runs client-side. Project export creates a file on the user's device. It does not connect to TerajuWorks or SunG Solution, and it does not provide cloud collaboration or a server database.

## Deploy
GitHub Pages is configured through the repository's Actions workflow in `.github/workflows/pages.yml`.
