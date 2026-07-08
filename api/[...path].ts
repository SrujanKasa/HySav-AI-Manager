// Vercel serverless entry — every /api/* request lands here and is handled
// by the same Express app the local server runs. Requires MONGODB_URI (and
// the other secrets) in the Vercel project's environment variables.
import { app } from "../hysav-api/src/app.ts";

export default app;
