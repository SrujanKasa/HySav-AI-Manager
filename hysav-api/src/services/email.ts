// Outbox-based email. Every message is recorded in email_outbox first, then
// delivered via Resend's HTTP API if RESEND_API_KEY is configured, otherwise
// logged to the console and marked 'logged' (so local dev shows exactly what
// would have been sent). Bodies never contain credentials.
import { env } from "../env.ts";
import { insert, now, one, update, uuid } from "../db.ts";

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
    const dup = await one("email_outbox", { dedupe_key: args.dedupeKey });
    if (dup) return;
  }
  const id = uuid();
  await insert("email_outbox", {
    id,
    workspace_id: args.workspaceId ?? null,
    to_email: args.to,
    subject: args.subject,
    body_text: args.text,
    kind: args.kind,
    status: "pending",
    created_at: now(),
    sent_at: null,
    ...(args.dedupeKey ? { dedupe_key: args.dedupeKey } : {}),
  });

  if (!env.resendApiKey) {
    console.log(`[email:logged] to=${args.to} subject="${args.subject}"`);
    await update("email_outbox", { id }, { status: "logged", sent_at: now() });
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
    await update("email_outbox", { id }, { status: res.ok ? "sent" : "failed", sent_at: now() });
    if (!res.ok) console.error(`[email] Resend returned ${res.status} for outbox ${id}`);
  } catch (err) {
    await update("email_outbox", { id }, { status: "failed" });
    console.error(`[email] delivery error for outbox ${id}:`, (err as Error).message);
  }
}
