-- YouTube serves channel avatars protocol-relative ("//yt3.googleusercontent.com/..."); clients read those as local
-- file paths and show the fallback icon. Thumbnails are stored absolute (`upsert_thumbnails`).
-- Where the https: twin already exists, it takes the owner and sizes it lacks and the relative row goes.
UPDATE "thumbnails_table" AS t
SET "id" = coalesce(t."id", r."id"), "width" = coalesce(t."width", r."width"), "height" = coalesce(t."height", r."height")
FROM "thumbnails_table" AS r
WHERE r."url" LIKE '//%' AND t."url" = 'https:' || r."url";
--> statement-breakpoint
DELETE FROM "thumbnails_table" AS r
USING "thumbnails_table" AS t
WHERE r."url" LIKE '//%' AND t."url" = 'https:' || r."url";
--> statement-breakpoint
UPDATE "thumbnails_table" SET "url" = 'https:' || "url" WHERE "url" LIKE '//%' AND length("url") <= 506;
