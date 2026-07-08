// Seeds the demo workspace ("Otterworks Inc.") with the same fictional
// 6-person startup the frontend demo used to hardcode — but now as real
// documents with ~30 days of usage-snapshot history, so the dashboard's
// numbers come out of the actual waste engine instead of being asserted.
//
// Demo login (documented, not secret): maya@otterworks.dev / otterworks-demo!
import { randomUUID } from "node:crypto";
import { hashPassword } from "./crypto.ts";
import { insert, now, one, uuid } from "./db.ts";
import { quoteForMembers } from "./services/billing.ts";

const DAY_MS = 86_400_000;

interface SeedMember {
  key: string;
  name: string;
  title: string;
  color: string;
  role: "admin" | "member";
}

const MEMBERS: SeedMember[] = [
  { key: "MK", name: "Maya Kern", title: "Founder / CEO", color: "#E4570F", role: "admin" },
  { key: "DO", name: "Dev Osei", title: "Engineering", color: "#1E8F63", role: "member" },
  { key: "SR", name: "Sam Ruiz", title: "Design", color: "#6B5CD6", role: "member" },
  { key: "PN", name: "Priya Nair", title: "Marketing", color: "#C98A1B", role: "member" },
  { key: "JW", name: "Jonas Weber", title: "Engineering", color: "#2B7DB8", role: "member" },
  { key: "TO", name: "Tess Okafor", title: "Ops", color: "#CE4141", role: "member" },
];

interface SeedTool {
  slug: string;
  name: string;
  category: string;
  plan: string;
  status: "active" | "trial";
  costDollars: number;
  renewInDays: number;
  limit: number;
  unit: string;
  usedPctNow: number; //     latest snapshot, % of limit
  usedPct30dAgo: number; //  what the window delta should look like
  users: string[];
  idle: string[]; //         member keys with 35+ day-old last_active_at
  note: string;
}

// Tuned so the waste engine reproduces the old demo's story:
// midjourney/runway → waste, jasper+copyai → duplicates, perplexity/notion →
// idle seats, gamma → credits expiring, elevenlabs → cap warning, rest healthy.
const TOOLS: SeedTool[] = [
  {
    slug: "chatgpt", name: "ChatGPT Team", category: "llm-chat", plan: "Team · 7 seats",
    status: "active", costDollars: 175, renewInDays: 5, limit: 5000, unit: "messages quota",
    usedPctNow: 82, usedPct30dAgo: 4, users: ["MK", "DO", "SR", "PN", "JW", "TO"], idle: [],
    note: "Solid usage across every seat. Nothing to do here — enjoy a tool that's earning its keep.",
  },
  {
    slug: "claude", name: "Claude Team", category: "llm-chat", plan: "Team · 6 seats",
    status: "active", costDollars: 150, renewInDays: 4, limit: 100, unit: "usage allowance",
    usedPctNow: 88, usedPct30dAgo: 6, users: ["MK", "DO", "PN", "JW"], idle: [],
    note: "Heaviest-used tool in the stack. Engineering and marketing both live in it.",
  },
  {
    slug: "cursor", name: "Cursor", category: "coding-assistant", plan: "Pro · 4 seats",
    status: "active", costDollars: 160, renewInDays: 9, limit: 2000, unit: "fast-request credits",
    usedPctNow: 62, usedPct30dAgo: 8, users: ["DO", "JW", "MK"], idle: [],
    note: "62% of fast-request credits used with 9 days left in the cycle. On pace — no waste expected.",
  },
  {
    slug: "midjourney", name: "Midjourney", category: "image-gen", plan: "Standard · 2 seats",
    status: "active", costDollars: 60, renewInDays: 17, limit: 15, unit: "GPU hours",
    usedPctNow: 11, usedPct30dAgo: 10, users: ["SR", "PN"], idle: ["PN"],
    note: "No images generated in 26 days. Both seats renew soon. If the brand refresh is done, this is a cancel.",
  },
  {
    slug: "perplexity", name: "Perplexity Pro", category: "search", plan: "Pro · 3 seats",
    status: "active", costDollars: 60, renewInDays: 10, limit: 600, unit: "pro searches",
    usedPctNow: 41, usedPct30dAgo: 7, users: ["MK", "PN", "TO"], idle: ["TO"],
    note: "Two seats active, one fully idle. Tess hasn't run a search in 31 days — drop to 2 seats and save $20/mo.",
  },
  {
    slug: "jasper", name: "Jasper", category: "copywriting", plan: "Creator · 1 seat",
    status: "active", costDollars: 59, renewInDays: 5, limit: 50000, unit: "word credits",
    usedPctNow: 9, usedPct30dAgo: 7, users: ["PN"], idle: [],
    note: "Priya's seat. Heavy feature overlap with Copy.ai (Sam's seat). Pick one, save the other's full cost.",
  },
  {
    slug: "copyai", name: "Copy.ai", category: "copywriting", plan: "Pro · 1 seat",
    status: "active", costDollars: 49, renewInDays: 14, limit: 40000, unit: "word credits",
    usedPctNow: 24, usedPct30dAgo: 5, users: ["SR"], idle: [],
    note: "Sam's seat. Overlaps heavily with Jasper. Whichever the team prefers, one of these should go.",
  },
  {
    slug: "elevenlabs", name: "ElevenLabs", category: "voice", plan: "Creator · 1 seat",
    status: "active", costDollars: 22, renewInDays: 22, limit: 100000, unit: "character quota",
    usedPctNow: 93, usedPct30dAgo: 12, users: ["PN"], idle: [],
    note: "93% of character quota used with most of the cycle left. At this pace the cap lands early — the next tier is +$22/mo, cheaper than overage.",
  },
  {
    slug: "notion", name: "Notion AI", category: "productivity", plan: "Add-on · 6 seats",
    status: "active", costDollars: 60, renewInDays: 12, limit: 1200, unit: "AI responses",
    usedPctNow: 47, usedPct30dAgo: 9, users: ["MK", "DO", "SR", "PN", "JW", "TO"], idle: ["JW", "TO"],
    note: "Half the team uses it weekly, half never touched it. Worth a quick ask before renewal.",
  },
  {
    slug: "runway", name: "Runway", category: "video-gen", plan: "Pro · 1 seat",
    status: "trial", costDollars: 76, renewInDays: 3, limit: 625, unit: "generation credits",
    usedPctNow: 6, usedPct30dAgo: 5, users: ["SR"], idle: [],
    note: "Free trial auto-converted to paid. Two videos rendered since. Renews again in days — the classic forgotten trial.",
  },
  {
    slug: "gamma", name: "Gamma", category: "presentation", plan: "Plus · 2 seats",
    status: "active", costDollars: 40, renewInDays: 10, limit: 400, unit: "AI credits",
    usedPctNow: 18, usedPct30dAgo: 4, users: ["MK", "TO"], idle: [],
    note: "Bought for the fundraise deck in April. Barely opened since. Pause until the next raise?",
  },
];

export async function seedDemoWorkspace(): Promise<boolean> {
  if (await one("workspaces", { name: "Otterworks Inc." })) return false;

  const ts = now();
  const nowMs = Date.now();
  const workspaceId = uuid();
  await insert("workspaces", { id: workspaceId, name: "Otterworks Inc.", created_at: ts });

  const userIdByKey = new Map<string, string>();
  for (const m of MEMBERS) {
    const userId = uuid();
    userIdByKey.set(m.key, userId);
    const email = m.name.split(" ")[0].toLowerCase() + "@otterworks.dev";
    await insert("users", { id: userId, email, name: m.name, password_hash: hashPassword("otterworks-demo!"), created_at: ts });
    await insert("memberships", {
      user_id: userId,
      workspace_id: workspaceId,
      role: m.role,
      initials: m.key,
      color: m.color,
      title: m.title,
      created_at: ts,
    });
  }

  for (const t of TOOLS) {
    const toolId = uuid();
    await insert("tools", {
      id: toolId,
      workspace_id: workspaceId,
      name: t.name,
      slug: t.slug,
      category: t.category,
      icon: null,
      plan: t.plan,
      status: t.status,
      cost_cents: Math.round(t.costDollars * 100),
      billing_cycle: "monthly",
      renewal_date: new Date(nowMs + t.renewInDays * DAY_MS).toISOString().slice(0, 10),
      credit_limit: t.limit,
      credit_unit: t.unit,
      usage_source: "manual",
      note: t.note,
      last_usage_update_at: new Date(nowMs - DAY_MS).toISOString(),
      created_at: ts,
      updated_at: ts,
    });

    for (const key of t.users) {
      const idleDays = t.idle.includes(key) ? 36 : 2;
      await insert("tool_members", {
        tool_id: toolId,
        user_id: userIdByKey.get(key)!,
        is_owner: key === t.users[0] ? 1 : 0,
        last_active_at: new Date(nowMs - idleDays * DAY_MS).toISOString(),
      });
    }

    // ~15 snapshots over the last 30 days, interpolating from the 30d-ago
    // level to today's level (linear + slight tail-off is fine for demo data).
    const steps = 15;
    for (let i = 0; i <= steps; i++) {
      const daysAgo = 30 - (30 * i) / steps;
      const pct = t.usedPct30dAgo + ((t.usedPctNow - t.usedPct30dAgo) * i) / steps;
      await insert("usage_snapshots", {
        id: uuid(),
        tool_id: toolId,
        captured_at: new Date(nowMs - daysAgo * DAY_MS).toISOString(),
        used_amount: Math.round((pct / 100) * t.limit * 100) / 100,
        limit_amount: t.limit,
        source: "manual",
      });
    }
  }
  return true;
}

/* ============================================================
   DEV/TEST-ONLY QA seed — hard-excluded from production.
   Creates the QA login hynexsbusiness@gmail.com whose password comes from
   SEED_TEST_USER_PASSWORD (never hardcoded, never committed). The workspace
   gets 5 members so the live quote lands on the top tier (Team Plus,
   ₹450/mo) and a paid period 365 days out, so QA can exercise the full
   logged-in flow without running Razorpay checkout every time.
   ============================================================ */
export async function seedTestAccount(): Promise<boolean> {
  if (process.env.NODE_ENV === "production") return false; // never in prod
  const password = process.env.SEED_TEST_USER_PASSWORD;
  if (!password) {
    console.warn("[seed] SEED_TEST_USER_PASSWORD not set — QA test account skipped");
    return false;
  }
  const email = "hynexsbusiness@gmail.com";
  if (await one("users", { email })) return false;

  const ts = now();
  const workspaceId = uuid();
  const userId = uuid();
  await insert("workspaces", { id: workspaceId, name: "HyNexs QA", created_at: ts });
  await insert("users", { id: userId, email, name: "HyNexs QA", password_hash: hashPassword(password), created_at: ts });
  await insert("memberships", {
    user_id: userId,
    workspace_id: workspaceId,
    role: "admin",
    initials: "HQ",
    color: "#E4570F",
    title: "QA Admin",
    created_at: ts,
  });

  // filler members (random unusable passwords) to push the quote to Team Plus
  const fillers = ["Asha Rao", "Kiran Patel", "Neel Shah", "Ravi Iyer"];
  for (const name of fillers) {
    const fid = uuid();
    await insert("users", {
      id: fid,
      email: name.toLowerCase().replace(/\s+/g, ".") + "@hysav.test",
      name,
      password_hash: hashPassword(randomUUID()), // random throwaway — never logged into
      created_at: ts,
    });
    await insert("memberships", {
      user_id: fid,
      workspace_id: workspaceId,
      role: "member",
      initials: name.split(" ").map((w) => w[0]).join(""),
      color: "#2B7DB8",
      title: "QA member",
      created_at: ts,
    });
  }

  // pre-activated top-tier plan: paid for a year, no Razorpay ids (dev seed)
  await insert("payments", {
    id: uuid(),
    workspace_id: workspaceId,
    amount_paise: quoteForMembers(1 + fillers.length).amountPaise,
    currency: "INR",
    status: "paid",
    period_start: ts,
    period_end: new Date(Date.now() + 365 * DAY_MS).toISOString(),
    created_at: ts,
    updated_at: ts,
  });
  console.log(`[seed] QA test account '${email}' created (dev-only, Team Plus paid 365d)`);
  return true;
}
