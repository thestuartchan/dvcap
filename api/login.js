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

  // Set a secure httpOnly cookie — never readable by client JS
  res.setHeader("Set-Cookie", [
    `mwd_auth=true; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 7}`,
  ]);

  return res.status(200).json({ ok: true });
}
