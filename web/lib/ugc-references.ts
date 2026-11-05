// The one place MAX_REFERENCES is written down.
//
// LIVES HERE, NOT IN actions/ugc.ts, even though attachSceneReferences (the
// function it was born beside) is the only place that enforces it server-
// side. A "use server" file can only export async functions — every other
// top-level export throws at build time — so a plain numeric constant a
// Client Component also needs (ugc-column.tsx's References box, capping what
// an operator can put in it) cannot be exported from actions/ugc.ts itself.
// Same reason lib/brief-guard.ts and lib/compile-guard.ts exist beside their
// own "use server" files.
//
// kie documents reference_image_urls as taking at most ten. The box has to
// cap at the SAME number attachSceneReferences will actually accept — a box
// that let in an eleventh reference would let the operator believe it was
// coming along for a render that silently drops it.
export const MAX_REFERENCES = 10;
