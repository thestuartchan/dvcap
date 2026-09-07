import { mintSession, sessionCookie, SESSION_MAX_AGE_S } from '../lib/session.js';

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;
  const CORRECT = process.env.DASHBOARD_PASSWORD;

  if (!CORRECT) {
    return res.status(500).json({ error: "Server misconfigured — DASHBOARD_PASSWORD not set" });
  }

  if (password !== CORRECT) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  // A SIGNED session, not the word "true". The old cookie was a constant published in this file:
  // sending it was the whole of being logged in, and every API route that checked for it was
  // checking that the caller could read a public repository. lib/session.js signs an expiry with
  // DASHBOARD_PASSWORD, so the cookie is something only the holder of the password can produce
  // and the server can verify without storing anything.
  const token = await mintSession(CORRECT);
  if (!token) return res.status(500).json({ error: "Server misconfigured — cannot mint a session" });
  res.setHeader("Set-Cookie", [sessionCookie(token, { maxAgeS: SESSION_MAX_AGE_S })]);

  return res.status(200).json({ ok: true });
}
