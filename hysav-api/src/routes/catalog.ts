// Curated catalog of common AI tools so "add a subscription" can be a picker
// instead of a blank form. Slugs match the logo assets shipped with the site
// (hysav-site/assets/logos/<slug>.png), so the frontend gets icons for free.
// Public + static: no auth, cacheable.
import { Router } from "express";

export const catalogRouter = Router();

interface CatalogEntry {
  slug: string;
  name: string;
  category: string;
  creditUnit: string | null;
  usageSource: "manual" | "openai" | "anthropic" | "elevenlabs" | "openrouter" | "vercel";
  hasLogo: boolean;
  typicalPlans: string[];
}

const CATALOG: CatalogEntry[] = [
  { slug: "chatgpt", name: "ChatGPT", category: "llm-chat", creditUnit: "messages quota", usageSource: "openai", hasLogo: true, typicalPlans: ["Plus", "Team"] },
  { slug: "claude", name: "Claude", category: "llm-chat", creditUnit: "usage allowance", usageSource: "anthropic", hasLogo: true, typicalPlans: ["Pro", "Team"] },
  { slug: "cursor", name: "Cursor", category: "coding-assistant", creditUnit: "fast-request credits", usageSource: "manual", hasLogo: true, typicalPlans: ["Pro", "Business"] },
  { slug: "githubcopilot", name: "GitHub Copilot", category: "coding-assistant", creditUnit: null, usageSource: "manual", hasLogo: true, typicalPlans: ["Individual", "Business"] },
  { slug: "midjourney", name: "Midjourney", category: "image-gen", creditUnit: "GPU hours", usageSource: "manual", hasLogo: true, typicalPlans: ["Basic", "Standard", "Pro"] },
  { slug: "runway", name: "Runway", category: "video-gen", creditUnit: "generation credits", usageSource: "manual", hasLogo: true, typicalPlans: ["Standard", "Pro"] },
  { slug: "perplexity", name: "Perplexity", category: "search", creditUnit: "pro searches", usageSource: "manual", hasLogo: true, typicalPlans: ["Pro"] },
  { slug: "jasper", name: "Jasper", category: "copywriting", creditUnit: "word credits", usageSource: "manual", hasLogo: true, typicalPlans: ["Creator", "Pro"] },
  { slug: "copyai", name: "Copy.ai", category: "copywriting", creditUnit: "word credits", usageSource: "manual", hasLogo: true, typicalPlans: ["Pro"] },
  { slug: "elevenlabs", name: "ElevenLabs", category: "voice", creditUnit: "characters", usageSource: "elevenlabs", hasLogo: true, typicalPlans: ["Starter", "Creator"] },
  { slug: "openrouter", name: "OpenRouter", category: "llm-chat", creditUnit: "USD credits", usageSource: "openrouter", hasLogo: false, typicalPlans: ["Pay as you go"] },
  { slug: "notion", name: "Notion AI", category: "productivity", creditUnit: "AI responses", usageSource: "manual", hasLogo: true, typicalPlans: ["AI add-on"] },
  { slug: "gamma", name: "Gamma", category: "presentation", creditUnit: "AI credits", usageSource: "manual", hasLogo: true, typicalPlans: ["Plus", "Pro"] },
  { slug: "openai-api", name: "OpenAI API", category: "llm-chat", creditUnit: "USD spend", usageSource: "openai", hasLogo: false, typicalPlans: ["Pay as you go"] },
  { slug: "anthropic-api", name: "Anthropic API", category: "llm-chat", creditUnit: "USD spend", usageSource: "anthropic", hasLogo: false, typicalPlans: ["Pay as you go"] },
  { slug: "vercel", name: "Vercel", category: "other", creditUnit: "USD spend", usageSource: "vercel", hasLogo: false, typicalPlans: ["Pro"] },
];

catalogRouter.get("/tools", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(CATALOG);
});
