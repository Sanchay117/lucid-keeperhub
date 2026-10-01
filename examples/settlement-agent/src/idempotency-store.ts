/**
 * A Lucid idempotency store kept in a JSON file, so it survives a restart.
 *
 * Lucid's default store lives in memory. After a restart it has forgotten
 * every request, so a buyer's paid retry runs the handler again: the buyer's
 * x402 client signs a fresh authorization, Lucid settles it, and the buyer
 * pays twice for one payout (KeeperHub's own idempotency still stops a second
 * transfer). With the record on disk, Lucid replays the stored response before
 * payment admission, and the retry is not charged.
 *
 * One process, one file. Several instances need a shared store, such as Redis
 * or Postgres, behind the same interface.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { HttpIdempotencyStore, StoredHttpResponse } from "@lucid-agents/types/http";

type StoredRecord = {
  fingerprint: string;
  ownerId: string;
  expiresAt: number;
  response?: StoredHttpResponse;
};

export type FileIdempotencyStore = HttpIdempotencyStore & {
  /** Forgets every record, as a crash that lost the file would. */
  wipe(): void;
};

export function createFileIdempotencyStore(path: string): FileIdempotencyStore {
  const records = new Map<string, StoredRecord>(
    existsSync(path)
      ? Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, StoredRecord>)
      : []
  );
  const recordKey = (scope: string, key: string) => `${scope}\0${key}`;

  // Written whole and renamed into place, so a crash mid-write leaves the
  // previous file rather than a truncated one.
  const persist = () => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(Object.fromEntries(records)));
    renameSync(`${path}.tmp`, path);
  };

  const purgeExpired = (now: number) => {
    for (const [id, record] of records) {
      if (record.expiresAt <= now) records.delete(id);
    }
  };

  // Same claim semantics as Lucid's in-memory store. There is deliberately no
  // `close`: Lucid calls it when a runtime closes, and a restart must not
  // forget anything.
  return {
    async claim(scope, key, fingerprint, ownerId, expiresAt, claimedAt) {
      purgeExpired(claimedAt);
      const id = recordKey(scope, key);
      const current = records.get(id);
      if (current) {
        if (current.fingerprint !== fingerprint) return { state: "conflict" };
        if (current.response) return { state: "completed", response: current.response };
        return { state: "in_progress" };
      }
      records.set(id, { fingerprint, ownerId, expiresAt });
      persist();
      return { state: "claimed" };
    },

    async complete(scope, key, ownerId, response, expiresAt) {
      const id = recordKey(scope, key);
      const current = records.get(id);
      if (!current || current.ownerId !== ownerId || current.response) return false;
      records.set(id, { ...current, response, expiresAt });
      persist();
      return true;
    },

    async release(scope, key, ownerId) {
      const id = recordKey(scope, key);
      if (records.get(id)?.ownerId !== ownerId) return;
      records.delete(id);
      persist();
    },

    wipe() {
      records.clear();
      persist();
    },
  };
}
