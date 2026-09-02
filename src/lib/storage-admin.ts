import { getDb } from "@/db";
import { clips, jobs, mediaAssets } from "@/db/schema";
import { listObjectsPage, type R2ListedObject } from "./object-storage";

export type StorageReference = { type: "job" | "clip" | "media_asset"; id: string; field: string; label: string };

export async function loadStorageReferences(): Promise<Map<string, StorageReference[]>> {
  const [jobRows, clipRows, assetRows] = await Promise.all([
    getDb().select({ id: jobs.id, name: jobs.sourceName, source: jobs.sourceObjectKey, music: jobs.musicObjectKey }).from(jobs),
    getDb().select({ id: clips.id, title: clips.title, object: clips.objectKey, poster: clips.posterObjectKey, original: clips.originalObjectKey, music: clips.musicObjectKey }).from(clips),
    getDb().select({ id: mediaAssets.id, name: mediaAssets.name, object: mediaAssets.objectKey }).from(mediaAssets),
  ]);
  const refs = new Map<string, StorageReference[]>();
  const add = (key: string | null, reference: StorageReference) => {
    if (!key) return;
    refs.set(key, [...(refs.get(key) ?? []), reference]);
  };
  for (const row of jobRows) {
    add(row.source, { type: "job", id: row.id, field: "sourceObjectKey", label: row.name });
    add(row.music, { type: "job", id: row.id, field: "musicObjectKey", label: row.name });
  }
  for (const row of clipRows) {
    add(row.object, { type: "clip", id: row.id, field: "objectKey", label: row.title });
    add(row.poster, { type: "clip", id: row.id, field: "posterObjectKey", label: row.title });
    add(row.original, { type: "clip", id: row.id, field: "originalObjectKey", label: row.title });
    add(row.music, { type: "clip", id: row.id, field: "musicObjectKey", label: row.title });
  }
  for (const row of assetRows) add(row.object, { type: "media_asset", id: row.id, field: "objectKey", label: row.name });
  return refs;
}

export async function listAllObjects(): Promise<R2ListedObject[]> {
  const result: R2ListedObject[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await listObjectsPage({ continuationToken, maxKeys: 1000 });
    result.push(...page.objects);
    continuationToken = page.nextToken ?? undefined;
  } while (continuationToken);
  return result;
}
