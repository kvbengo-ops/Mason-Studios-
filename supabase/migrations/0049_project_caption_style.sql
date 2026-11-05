-- =============================================================================
-- projects.{captions_enabled,caption_box_color,caption_text_color} —
-- per-project caption settings
--
-- Captions have been all-or-nothing since they shipped: the CAPTIONS_ENABLED
-- env var, which render.yaml requires the web and worker services to hold
-- identically. That is a deploy-level switch for the whole team, and it is
-- the wrong granularity for a decision that belongs to one ad.
--
-- The palette was worse than coarse, it was wrong. worker/internal/captions/
-- ass.go carried the highlight-box colour as a single constant, and its own
-- comment recorded where the value came from: "sampled directly from
-- demo/demo1.mp4's own highlight boxes by the proof of concept, not an
-- invented brand colour." Every ad this system has ever rendered highlights
-- its words in a purple lifted from a reference video belonging to someone
-- else. For a brand selling a green pouch that is not a preference, it is a
-- defect.
--
-- Why plain typed columns rather than a jsonb blob, and why here rather than
-- a caption_styles table: the same reasoning 0013 set out for the six
-- directorial inputs. These are OUR product vocabulary, not a passthrough of
-- some vendor's request shape; nothing downstream branches on a model or a
-- provider to decide whether a value is legal; and there is exactly one row
-- of them per project. A separate table would buy a join and nothing else.
--
-- Deliberately NOT included: font family, font size, and caption position.
-- Those are not one more column each. libass sizes a font by the OS/2
-- usWinAscent + usWinDescent metrics rather than unitsPerEm (see
-- worker/internal/captions/measure.go, which exists because getting this
-- wrong made every measured caption width ~42% too wide), so a new font is
-- not a drop-in value — it arrives with its own metrics that have to be
-- measured before anything it renders can be trusted. Colour has no such
-- trap: it changes what is drawn, never where.
-- =============================================================================

alter table projects
  add column if not exists captions_enabled boolean not null default true,
  add column if not exists caption_box_color text not null default '#730BF9',
  add column if not exists caption_text_color text not null default '#FFFFFF';

-- The defaults reproduce today's rendering exactly, so no existing project
-- changes appearance when this lands.
--
-- '#730BF9' is ass.go's retired boxColorASS constant, '&H00F90B73&', read
-- back into RGB. ASS colours are &HAABBGGRR& — alpha, then BLUE, GREEN, RED
-- — so the swap is not cosmetic: pasting the ASS digits in as hex would give
-- '#F90B73', a pink, and every existing project would silently change colour
-- on its next assemble. Nothing about that failure looks like a failure; the
-- video renders fine, in the wrong colour.
--
--   &H 00 F9 0B 73 &  ->  alpha 00, B=F9(249), G=0B(11), R=73(115)
--   RGB(115, 11, 249) ->  #730BF9
--
-- worker/internal/captions/color.go owns that conversion for the render
-- path, and TestDefaultColorsMatchLegacyASS asserts these two literals still
-- produce the pre-migration ASS strings.
--
-- captions_enabled defaults to TRUE even though CAPTIONS_ENABLED defaults to
-- off. The two are ANDed, and they answer different questions: the env var
-- is the org's global kill-switch, this column is one project opting out
-- from under it. Defaulting the column to false would mean an operator who
-- turns captions on globally gets captions on exactly zero projects and no
-- indication why.

comment on column projects.captions_enabled is
  'Per-project caption opt-out. ANDed with the worker''s CAPTIONS_ENABLED env var (the global kill-switch) in internal/loop/assemble.go — both must be true for captions to render.';

comment on column projects.caption_box_color is
  'Karaoke highlight box fill, #RRGGBB. Converted to ASS''s reversed &HAABBGGRR& byte order by worker/internal/captions/color.go, never stored in that form.';

comment on column projects.caption_text_color is
  'Caption text fill (the ASS style''s PrimaryColour), #RRGGBB. The near-black outline behind it is NOT configurable — it is what keeps text legible against the video, not a palette choice.';

-- Format is enforced in the schema as well as in the two application layers
-- that write and read it. Not redundancy for its own sake: a bad value here
-- does not fail loudly, it reaches libass as an unparseable colour token and
-- silently draws the wrong thing (or nothing) into a video someone already
-- paid to render. The constraint is what stops a seed script or a manual
-- UPDATE from getting there.
--
-- Six digits only. Three-digit shorthand ('#FFF') is rejected rather than
-- expanded, so there is exactly one spelling of a colour in this column and
-- no expansion rule that has to be implemented identically in SQL, in
-- TypeScript and in Go.
alter table projects
  add constraint projects_caption_box_color_check
  check (caption_box_color ~ '^#[0-9A-Fa-f]{6}$');

alter table projects
  add constraint projects_caption_text_color_check
  check (caption_text_color ~ '^#[0-9A-Fa-f]{6}$');
