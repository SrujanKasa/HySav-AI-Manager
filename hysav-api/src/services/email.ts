// Outbox-based email. Every message is recorded in email_outbox first, then
// delivered via Resend's HTTP API if RESEND_API_KEY is configured, otherwise
// logged to the console and marked 'logged' (so local dev shows exactly what
// would have been sent). Bodies never contain credentials.
import { env } from "../env.ts";
import { now, one, run, uuid } from "../db.ts";

interface SendArgs {
  workspaceId?: string | null;
  to: string;
  subject: string;
  text: string;
  kind: "waste_alert" | "renewal_alert" | "digest" | "invite";
  /** stable key so recurring scans don't resend the same alert */
  dedupeKey?: string;
}

export async function sendEmail(args: SendArgs): Promise<void> {
  if (args.dedupeKey) {
    const dup = one("SELECT id FROM email_outbox WHERE dedupe_key = ?", args.dedupeKey);
    if (dup) return;
  }
  const id = uuid();
  run(
    `INSERT INTO email_outbox (id, workspace_id, to_email, subject, body_text, kind, status, created_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    args.workspaceId ?? null,
    args.to,
    args.subject,
    args.text,
    args.kind,
    now(),
    args.dedupeKey ?? null,
  );

  if (!env.resendApiKey) {
    console.log(`[email:logged] to=${args.to} subject="${args.subject}"`);
    run("UPDATE email_outbox SET status = 'logged', sent_at = ? WHERE id = ?", now(), id);
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: env.emailFrom, to: [args.to], subject: args.subject, text: args.text }),
    });
    run(
      "UPDATE email_outbox SET status = ?, sent_at = ? WHERE id = ?",
      res.ok ? "sent" : "failed",
      now(),
      id,
    );
    if (!res.ok) console.error(`[email] Resend returned ${res.status} for outbox ${id}`);
  } catch (err) {
    run("UPDATE email_outbox SET status = 'failed' WHERE id = ?", id);
    console.error(`[email] delivery error for outbox ${id}:`, (err as Error).message);
  }
}
