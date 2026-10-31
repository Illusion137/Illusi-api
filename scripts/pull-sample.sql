-- Writes a sample of the database to stdout as `COPY ... FROM stdin` blocks, for scripts/pull-sample.sh to load
-- into a local, freshly migrated Postgres. Nothing on the server is written: the setup creates temp tables only,
-- and the rows are read in one REPEATABLE READ, READ ONLY transaction (a consistent snapshot). Read-only
-- transactions allow writing temp tables but not creating them, hence the empty tables made up front.
--
-- Expects these psql variables (pull-sample.sh prepends the \set lines):
--   users      how many users to sample when `user_list` is empty
--   pick       'active' (most library rows first) or 'random'
--   user_list  comma-separated user ids or emails; overrides `users`/`pick` when non-empty
--   skip       comma-separated tables never copied
--   dev_hash   password hash every sampled user gets
--   plan_file  scratch file for the generated COPY statements (a few KB; removed at the end)
--
-- Tables are classified from the live catalog, so new tables need no change here:
--   personal  users_table, and every table with a NOT NULL foreign key to a personal table (user_tracks,
--             playlists and their children, plays, contributions, ...): only rows of the sampled users
--   global    everything else (the catalog: artists, albums, tracks, service ids, lyrics, vectors, ...): every row
--   skipped   `skip`: credentials and per-request bookkeeping (sessions, action token uses, sync push replays)
-- A nullable foreign key to a personal table (e.g. `review_items_table.resolved_by`) keeps sampled users and is
-- set to null otherwise. User ids in columns without a foreign key (audit log, source_user_id, uploaded_by) are
-- kept as they are, so they still match the sampled users.

\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
\pset footer off

create temp table _params as select
	:'users'::int as users,
	:'pick'::text as pick,
	array_remove(string_to_array(:'user_list', ','), '') as user_list,
	array_remove(string_to_array(:'skip', ','), '') as skip,
	:'dev_hash'::text as dev_hash;

do $$
declare
	p _params;
	changed boolean := true;
	rec record;
	t text;
	filter text;
	cols text;
	exprs text;
	n int := 0;
begin
	select * into p from _params;

	-- Single-column foreign keys in public: child.col -> parent.ref, with the child column's nullability.
	create temp table _fks as
	select c.conrelid::regclass::text as child, a.attname::text as col, a.attnotnull as not_null,
		c.confrelid::regclass::text as parent, ra.attname::text as ref, cardinality(c.conkey) as width
	from pg_constraint c
	join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
	join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = c.confkey[1]
	where c.contype = 'f' and c.connamespace = 'public'::regnamespace;

	create temp table _tables as
	select c.relname::text as name, c.relname = 'users_table' as personal, null::int as fill_ord, null::text as conds
	from pg_class c
	where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
		and c.relname <> all(p.skip);

	-- Personal = reachable from users_table through NOT NULL foreign keys.
	while changed loop
		update _tables tt set personal = true
		where not tt.personal and exists (
			select 1 from _fks f join _tables pt on pt.name = f.parent and pt.personal
			where f.child = tt.name and f.not_null and f.child <> f.parent);
		changed := found;
	end loop;

	if exists (select 1 from _fks f join _tables pt on pt.name = f.parent and pt.personal where f.width > 1) then
		raise exception 'multi-column foreign key to a personal table: extend pull-sample.sql';
	end if;

	-- Fill order for the personal tables (parents first), each with its row filter.
	update _tables set fill_ord = 0 where name = 'users_table';
	loop
		select tt.name into t from _tables tt
		where tt.personal and tt.fill_ord is null and not exists (
			select 1 from _fks f join _tables pp on pp.name = f.parent and pp.personal and pp.fill_ord is null
			where f.child = tt.name and f.not_null and f.parent <> tt.name)
		order by tt.name limit 1;
		exit when t is null;
		n := n + 1;
		select coalesce(string_agg(format('%I in (select %I from %I)', f.col, f.ref, '_s_' || f.parent), ' and '), 'true')
		into filter
		from _fks f join _tables pp on pp.name = f.parent and pp.personal
		where f.child = t and f.not_null and f.parent <> t;
		update _tables set fill_ord = n, conds = filter where name = t;
		t := null;
	end loop;
	if exists (select 1 from _tables where personal and fill_ord is null) then
		raise exception 'cycle among personal tables: %', (select string_agg(name, ', ') from _tables where personal and fill_ord is null);
	end if;

	for rec in select name from _tables where personal loop
		execute format('create temp table %I as select * from %I with no data', '_s_' || rec.name, rec.name);
	end loop;

	-- One COPY block per table. Generated columns are left out; the target computes them.
	create temp table _plan (ord int, line text);
	n := 0;
	for rec in select name, personal from _tables order by name loop
		select string_agg(format('%I', a.attname), ', ' order by a.attnum),
			string_agg(coalesce(
				(select format('case when %1$I is null or %1$I in (select %2$I from %3$I) then %1$I end', a.attname, f.ref, '_s_' || f.parent)
					from _fks f join _tables pp on pp.name = f.parent and pp.personal
					where f.child = rec.name and f.col = a.attname and not f.not_null limit 1),
				format('%I', a.attname)), ', ' order by a.attnum)
		into cols, exprs
		from pg_attribute a
		where a.attrelid = format('public.%I', rec.name)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';

		n := n + 1;
		insert into _plan values
			(n * 3, format('select %L;', format('COPY public.%I (%s) FROM stdin;', rec.name, cols))),
			(n * 3 + 1, format('COPY (select %s from %I) TO STDOUT;', exprs, case when rec.personal then '_s_' || rec.name else rec.name end)),
			(n * 3 + 2, 'select ''\.'';');
	end loop;
end
$$;

\o :plan_file
select line from _plan order by ord;
\o

begin isolation level repeatable read read only;

do $$
declare
	p _params;
	rec record;
begin
	select * into p from _params;

	-- Sampled users, anonymized.
	if cardinality(p.user_list) > 0 then
		insert into _s_users_table select u.* from users_table u where u.id::text = any(p.user_list) or u.email = any(p.user_list);
	elsif p.pick = 'random' then
		insert into _s_users_table select u.* from users_table u order by random() limit p.users;
	else
		insert into _s_users_table select u.* from users_table u
			order by (select count(*) from user_tracks_table ut where ut.user_id = u.id) desc, u.created_at limit p.users;
	end if;
	update _s_users_table set
		email = 'user-' || left(id::text, 8) || '@staging.invalid',
		username = 'user_' || left(id::text, 8),
		password_hash = p.dev_hash;

	for rec in select name, conds from _tables where personal and fill_ord > 0 order by fill_ord loop
		execute format('insert into %I select * from %I where %s', '_s_' || rec.name, rec.name, rec.conds);
	end loop;
end
$$;

\i :plan_file
commit;
\setenv PLAN_FILE :plan_file
\! rm -f -- "$PLAN_FILE"
