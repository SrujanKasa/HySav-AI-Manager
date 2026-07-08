// Single DB access point — MongoDB.
//
// Production/hosted: set MONGODB_URI (MongoDB Atlas connection string). The
// client is cached at module scope so serverless invocations reuse the
// connection.
// Local dev & tests: when MONGODB_URI is unset, an embedded mongod is spun up
// via mongodb-memory-server (devDependency) — zero install, works on this
// machine. Dev data persists under ./data/mongo; tests run fully in-memory.
//
// Documents keep the same snake_case field names the old SQL schema used
// (users, workspaces, memberships, invites, sessions, tools, tool_members,
// usage_snapshots, integration_credentials, notification_prefs, email_outbox,
// payments), so everything downstream reads identical row shapes.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, type Db, type Document, type Sort } from "mongodb";
import { env } from "./env.ts";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;

let dbPromise: Promise<Db> | null = null;

async function connect(): Promise<Db> {
  let uri = env.mongodbUri;
  if (!uri) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("MONGODB_URI is required in production (MongoDB Atlas connection string)");
    }
    // dev/test fallback: embedded mongod, persisted under ./data/mongo
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    let server: InstanceType<typeof MongoMemoryServer>;
    if (isTest) {
      server = await MongoMemoryServer.create();
    } else {
      const dbPath = resolve("./data/mongo");
      mkdirSync(dbPath, { recursive: true });
      server = await MongoMemoryServer.create({
        instance: { dbPath, storageEngine: "wiredTiger" },
      });
      console.log("[db] embedded MongoDB (mongodb-memory-server) at", server.getUri());
    }
    uri = server.getUri();
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "hysav");
  await ensureIndexes(db);
  return db;
}

export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = connect();
  return dbPromise;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ token_hash: 1 }, { unique: true }),
    db.collection("invites").createIndex({ token_hash: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ user_id: 1, workspace_id: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ workspace_id: 1 }),
    db.collection("tools").createIndex({ workspace_id: 1 }),
    db.collection("tool_members").createIndex({ tool_id: 1, user_id: 1 }, { unique: true }),
    db.collection("usage_snapshots").createIndex({ tool_id: 1, captured_at: 1 }),
    db.collection("integration_credentials").createIndex({ workspace_id: 1, provider: 1 }, { unique: true }),
    db.collection("notification_prefs").createIndex({ user_id: 1, workspace_id: 1 }, { unique: true }),
    db.collection("email_outbox").createIndex({ dedupe_key: 1 }, { unique: true, sparse: true }),
    db.collection("payments").createIndex({ workspace_id: 1, status: 1 }),
    db.collection("payments").createIndex({ razorpay_order_id: 1 }, { unique: true, sparse: true }),
    db.collection("payments").createIndex({ razorpay_subscription_id: 1 }, { unique: true, sparse: true }),
  ]);
}

const NO_ID = { projection: { _id: 0 } } as const;

export async function one<T = Document>(coll: string, filter: Document): Promise<T | undefined> {
  const db = await getDb();
  return ((await db.collection(coll).findOne(filter, NO_ID)) ?? undefined) as T | undefined;
}

export async function all<T = Document>(
  coll: string,
  filter: Document,
  opts: { sort?: Sort; limit?: number } = {},
): Promise<T[]> {
  const db = await getDb();
  let cursor = db.collection(coll).find(filter, NO_ID);
  if (opts.sort) cursor = cursor.sort(opts.sort);
  if (opts.limit) cursor = cursor.limit(opts.limit);
  return (await cursor.toArray()) as T[];
}

export async function insert(coll: string, doc: Document): Promise<void> {
  const db = await getDb();
  await db.collection(coll).insertOne({ ...doc });
}

/** try-insert that ignores duplicate-key conflicts (ON CONFLICT DO NOTHING) */
export async function insertIgnoreDup(coll: string, doc: Document): Promise<void> {
  try {
    await insert(coll, doc);
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export async function update(coll: string, filter: Document, set: Document, upsert = false): Promise<void> {
  const db = await getDb();
  await db.collection(coll).updateMany(filter, { $set: set }, { upsert });
}

export async function remove(coll: string, filter: Document): Promise<void> {
  const db = await getDb();
  await db.collection(coll).deleteMany(filter);
}

export async function count(coll: string, filter: Document): Promise<number> {
  const db = await getDb();
  return db.collection(coll).countDocuments(filter);
}

export function uuid(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}
