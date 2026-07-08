// Vercel serverless entry — vercel.json rewrites every /api/v1/* request to
// this function, which hands the untouched URL to the same Express app the
// local server runs. The backend is compiled to hysav-api/dist during the
// Vercel build (see vercel.json buildCommand). Requires MONGODB_URI (and the
// other secrets) in the Vercel project's environment variables.
import { app } from "../hysav-api/dist/app.js";

export default app;
