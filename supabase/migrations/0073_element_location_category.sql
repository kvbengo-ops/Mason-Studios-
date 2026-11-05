-- A saved reference can be a PLACE.
--
-- elements.category has been character/product/voice since 0065, and the
-- third of those is a placeholder: a voice element stores an image, because
-- assets.kind has no audio member. So what an operator can actually save is a
-- person or a thing — and the workflow this route serves needs a third,
-- because the prompts being written already name one:
--
--     "@lena at the counter in @kitchen holding @kinoko"
--
-- Without it a backdrop has to be filed as a 'product', and that is not a
-- naming quibble. The category decides what the model is told about the
-- picture, and the two say opposite things:
--
--     product   use its shape, material, colour and label
--     location  use the setting, its surfaces and its light —
--               and NOT any people visible in it
--
-- That last clause is the whole point. A backdrop photograph almost always
-- has someone standing in it, and a reference described as a product hands
-- the model a stranger to put in the clip beside the character it was asked
-- for. 0071's scene_references already admits 'location' for exactly this
-- reason; this is the column that decides whether one can ever be created.
--
-- Nothing existing moves. Every row keeps the category it has, and a widened
-- CHECK cannot invalidate one.

alter table elements drop constraint if exists elements_category_check;
alter table elements
  add constraint elements_category_check
  check (category in ('character', 'product', 'voice', 'location'));

comment on column elements.category is
  'What this saved reference depicts: ''character'', ''product'', ''location'', or ''voice''. '
  'Read by the worker to describe the reference truthfully — "use the person''s face, hair and '
  'clothing" is right about a character and actively wrong about a bottle or a backdrop, and a '
  'location is the one kind whose PEOPLE must be excluded rather than reproduced. '
  '''voice'' remains a placeholder that stores an image: assets.kind has no audio member, so '
  'there is nowhere to put a recording yet.';
