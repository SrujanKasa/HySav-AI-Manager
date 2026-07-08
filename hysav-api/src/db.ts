// Single DB access point. Uses Node's built-in SQLite driver (node:sqlite,
// stable since 22.13) so local dev needs zero infrastructure.
//
// Postgres note: this repo's environment has no Postgres/Docker available, so
// SQLite is the working default. The schema (schema.sql) is deliberately
// ANSI-portable and all SQL lives behind this module + route queries with
// standard syntax; migrating to Postgres (Neon/Vercel Postgres) means
// swapping this module for a pg Pool and re-running schema.sql — no model
// changes.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { env } from "./env.ts";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST !== undefined;
const dbPath = isTest ? ":memory:" : resolve(env.databasePath);
if (!isTest) mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));

// Lightweight migrations for DBs created before a column existed (schema.sql
// only covers fresh databases — CREATE TABLE IF NOT EXISTS won't alter).
try {
  db.exec("ALTER TABLE payments ADD COLUMN razorpay_subscription_id TEXT");
} catch {
  /* column already exists */
}

export function uuid(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

type Row = Record<string, unknown>;

export function one<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: (string | number | null)[]): void {
  db.prepare(sql).run(...params);
}
