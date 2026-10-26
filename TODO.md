# TODO

## Playlist artwork

Custom playlist artwork used to live in Supabase storage (`playlist-artwork` bucket, keyed by playlist uuid) and
was uploaded by the old Illusive sync engine. The API has no storage for it yet, so the new sync engine doesn't
sync custom artwork: it stays on the device that set it (`artwork_path` in the local DB) and other devices fall
back to the generated cover.

Needed:
- an upload endpoint (`PUT /playlists/:id/artwork`, owner only, image validation and size limit, stored next to media);
- an artwork URL or resource id on `playlists_table`, returned by sync pull and the read API;
- a client upload step in the Illusive sync engine, and a one-time upload of existing local artwork after migration;
- optionally, a one-off import of the old Supabase bucket for users who re-register.

## Backpack

- Admin view of `track_unavailable_reports_table` and `track_research_table` (most-reported, stuck tracks).
- When an admin resolves a `youtube_id`/`soundcloud_permalink`/`bandlab_id`/`audiomack_id` conflict in favour of
  the incoming value on a backpacked track, clear `backpacked` too.
