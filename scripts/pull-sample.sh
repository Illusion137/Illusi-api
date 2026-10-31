#!/usr/bin/env bash
# Pulls a sample of the production database into a local Postgres, for testing against real data (staging).
# The catalog comes across whole; personal data only for a few users, anonymized: emails become
# user-<id8>@staging.invalid, usernames user_<id8>, and every password is `illusi-staging`. Sessions, action token
# uses and sync push replays are never copied. The selection and the table rules live in scripts/pull-sample.sql.
#
#   scripts/pull-sample.sh [--users N] [--random] [--user <id|email>]... [--skip-table <table>]...
#                          [--local-url <postgres url>] [--port <port>] [--with-media <N>] [--media-dir <dir>]
#                          [--source-url <postgres url>] [--save <file.sql.gz>] [--from <file.sql.gz>] [--yes]
#
#   --users N        sample the N users with the largest libraries (default 5); --random picks N at random
#   --user X         sample exactly these users (id or email; repeatable)
#   --local-url URL  load into this database instead of the default container. Every table in it is emptied first.
#   --port P         port of the default container `illusi-staging-pg` (default 55440), recreated database each run
#   --with-media N   also download up to N media files of the sampled users' library tracks into --media-dir
#                    (default ./data/media); without it media rows exist but their files don't
#   --source-url URL read from this database directly instead of the VPS (e.g. a restored backup)
#   --save FILE      keep the downloaded sample (gzipped SQL); load it again later with --from FILE
#   --from FILE      load a sample saved with --save instead of downloading one
#   STAGING_CONTAINER=name  use another container name than illusi-staging-pg
#
# SSH settings come from .secrets (see .secrets.example). On the VPS the sample is read inside the db container in
# one read-only snapshot and streamed back compressed; nothing is written there. Migrations are applied locally
# (npm run db:migrate) before the data is loaded, and the load is one transaction that checks every foreign key.
set -euo pipefail
cd "$(dirname "$0")/.."

users=5
pick=active
user_list=()
skip=(sessions_table action_token_uses_table sync_pushes_table)
local_url=""
port=55440
media=0
media_dir=./data/media
source_url=""
save=""
from=""
assume_yes=0
while [[ $# -gt 0 ]]; do
	case "$1" in
		--users) users="$2"; shift ;;
		--random) pick=random ;;
		--user) user_list+=("$2"); shift ;;
		--skip-table) skip+=("$2"); shift ;;
		--local-url) local_url="$2"; shift ;;
		--port) port="$2"; shift ;;
		--with-media) media="$2"; shift ;;
		--media-dir) media_dir="$2"; shift ;;
		--source-url) source_url="$2"; shift ;;
		--save) save="$2"; shift ;;
		--from) from="$2"; shift ;;
		--yes | -y) assume_yes=1 ;;
		*) echo "unknown option $1" >&2; exit 2 ;;
	esac
	shift
done

die() { echo "error: $*" >&2; exit 1; }
[[ "$users" =~ ^[0-9]+$ && "$media" =~ ^[0-9]+$ && "$port" =~ ^[0-9]+$ ]] || die "--users, --with-media and --port take numbers"
[[ -z "$from" || -f "$from" ]] || die "$from not found"
for u in ${user_list[@]+"${user_list[@]}"}; do [[ "$u" != *[\',]* ]] || die "--user $u: quotes and commas aren't supported"; done
[[ -z "$source_url" ]] || command -v psql > /dev/null || die "--source-url needs psql on PATH"

CONTAINER="${STAGING_CONTAINER:-illusi-staging-pg}"
PG_IMAGE=pgvector/pgvector:0.8.7-pg17-bookworm
DEV_HASH='$argon2id$v=19$m=65536,p=4,t=3$Z8nzf/g1om07SgDpdPvadQ$IWuZPpmNgr383vXtPhMhCPDxz33rHpQq8J7S40zgFSs'

ssh_tmp=""
if [[ -z "$from" && -z "$source_url" ]] || [[ "$media" -gt 0 ]]; then
	# shellcheck source=scripts/lib/ssh.sh
	. scripts/lib/ssh.sh
fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" ${ssh_tmp:+"$ssh_tmp"}' EXIT

join() { local IFS=,; echo "$*"; }

# The sampling script with its parameters prepended; `$1` is the plan file path where psql runs.
sample_sql() {
	printf '\\set users %s\n\\set pick %s\n\\set user_list %s\n\\set skip %s\n\\set dev_hash %s\n\\set plan_file %s\n' \
		"$users" "$pick" "'$(join ${user_list[@]+"${user_list[@]}"})'" "'$(join "${skip[@]}")'" "'$DEV_HASH'" "'$1'"
	cat scripts/pull-sample.sql
}

# --- 1. download ---
sample="$tmp/sample.sql.gz"
if [[ -n "$from" ]]; then
	sample="$from"
elif [[ -n "$source_url" ]]; then
	echo "==> sampling $source_url"
	sample_sql "$tmp/plan.sql" | psql -X -q "$source_url" | gzip -1 > "$sample"
else
	echo "==> sampling the production database on $IP"
	# shellcheck disable=SC2016 # expanded inside the db container
	in_db='exec psql -X -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
	plan="/tmp/illusi-sample-plan-$$.sql"
	sample_sql "$plan" | remote_app -C -- "scripts/compose.sh exec -T db sh -c $(printf %q "$in_db")" | gzip -1 > "$sample"
fi
gzip -t "$sample" || die "the sample is corrupt"
echo "    $(du -h "$sample" | cut -f1) compressed"
if [[ -n "$save" ]]; then
	cp "$sample" "$save"
	echo "    saved to $save"
fi

# --- 2. local database ---
if [[ -z "$local_url" ]]; then
	if ! docker inspect "$CONTAINER" > /dev/null 2>&1; then
		echo "==> creating $CONTAINER on 127.0.0.1:$port"
		docker run -d --name "$CONTAINER" -p "127.0.0.1:$port:5432" \
			-e POSTGRES_USER=illusi -e POSTGRES_PASSWORD=illusi -e POSTGRES_DB=illusi "$PG_IMAGE" > /dev/null
	fi
	docker start "$CONTAINER" > /dev/null
	for _ in $(seq 1 60); do
		docker exec "$CONTAINER" pg_isready -U illusi -d postgres > /dev/null 2>&1 && break
		sleep 1
	done
	port="$(docker port "$CONTAINER" 5432/tcp | head -n 1 | sed 's/.*://')"
	docker exec "$CONTAINER" psql -X -q -U illusi -d postgres -v ON_ERROR_STOP=1 \
		-c 'drop database if exists illusi with (force)' -c 'create database illusi' > /dev/null
	local_url="postgres://illusi:illusi@127.0.0.1:$port/illusi"
	load() { docker exec -i "$CONTAINER" psql -X -q -U illusi -d illusi "$@"; }
else
	command -v psql > /dev/null || die "--local-url needs psql on PATH"
	if [[ "$assume_yes" -eq 0 ]]; then
		read -r -p "Empty every table in $local_url and load the sample? [y/N] " answer
		[[ "$answer" == [yY]* ]] || exit 1
	fi
	load() { psql -X -q "$local_url" "$@"; }
fi

echo "==> migrating"
DATABASE_URL="$local_url" npm run --silent db:migrate

# --- 3. load ---
echo "==> loading"
{
	cat <<-'SQL'
		\set ON_ERROR_STOP on
		-- Foreign keys and triggers are checked once at the end, not per row in COPY order.
		set session_replication_role = replica;
		do $$ declare t text; begin
			select string_agg(format('%I', relname), ', ') into t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r';
			if t is not null then execute 'truncate ' || t || ' restart identity cascade'; end if;
		end $$;
	SQL
	gzip -dc "$sample"
	cat <<-'SQL'
		set session_replication_role = origin;
		do $$ declare r record; bad bigint; begin
			-- Identity sequences continue after the loaded ids.
			for r in select c.relname, a.attname, pg_get_serial_sequence(format('%I', c.relname), a.attname) as seq
				from pg_attribute a join pg_class c on c.oid = a.attrelid
				where c.relnamespace = 'public'::regnamespace and a.attidentity <> '' loop
				execute format('select setval(%L, coalesce((select max(%I) from %I), 0) + 1, false)', r.seq, r.attname, r.relname);
			end loop;
			-- Every foreign key holds.
			for r in select conrelid::regclass as child, confrelid::regclass as parent, conname,
				(select string_agg(format('c.%I = p.%I', ca.attname, pa.attname), ' and ')
					from unnest(conkey, confkey) k(c, p)
					join pg_attribute ca on ca.attrelid = conrelid and ca.attnum = k.c
					join pg_attribute pa on pa.attrelid = confrelid and pa.attnum = k.p) as on_cols,
				(select string_agg(format('c.%I is not null', ca.attname), ' and ')
					from unnest(conkey) k(c) join pg_attribute ca on ca.attrelid = conrelid and ca.attnum = k.c) as not_null
				from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace loop
				execute format('select count(*) from %s c where %s and not exists (select 1 from %s p where %s)', r.child, r.not_null, r.parent, r.on_cols) into bad;
				if bad > 0 then raise exception 'foreign key % broken by % rows', r.conname, bad; end if;
			end loop;
		end $$;
	SQL
} | load -v ON_ERROR_STOP=1 --single-transaction > /dev/null

load -At -F '|' -c "select 'users', count(*) from users_table union all select 'tracks', count(*) from tracks_table
	union all select 'library rows', count(*) from user_tracks_table union all select 'playlists', count(*) from playlists_table
	union all select 'plays', count(*) from track_plays_table" | while IFS='|' read -r what n; do printf '    %-13s %s\n' "$what" "$n"; done

# --- 4. media ---
if [[ "$media" -gt 0 ]]; then
	echo "==> downloading up to $media media files into $media_dir"
	mkdir -p "$media_dir"
	load -At -c "select distinct m.resource_id from media_table m join user_tracks_table ut on ut.track_id = m.track_id
		where not ut.deleted order by m.resource_id limit $media" \
		| grep -E '^[0-9a-f-]{36}\.[a-z0-9]{2,5}$' > "$tmp/media.txt" || true
	if [[ -s "$tmp/media.txt" ]]; then
		remote_app -C -- 'set -a; . ./.env; set +a; tar -C "${DATA_DIR:-./data}/media" -cf - --ignore-failed-read -T -' < "$tmp/media.txt" \
			| tar -C "$media_dir" -xf -
	fi
	echo "    $(wc -l < "$tmp/media.txt" | tr -d ' ') files"
fi

echo "==> done: DATABASE_URL=$local_url (every sampled user's password is illusi-staging)"
