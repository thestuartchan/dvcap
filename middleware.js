export const config = {
  matcher: "/((?!api/).*)",
};

export default function middleware(request) {
  const url = new URL(request.url);

  // Allow the login page itself through always
  if (url.pathname === "/" && request.headers.get("cookie")?.includes("mwd_auth=true")) {
    return new Response(null, { status: 200 });
  }

  // Check for auth cookie
  const cookies = request.headers.get("cookie") || "";
  const isAuthed = cookies.includes("mwd_auth=true");

  if (isAuthed) {
    return new Response(null, { status: 200 });
  }

  // Not authenticated — serve the login page inline
  const loginHTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Market Watch Dashboard — Login</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%; height: 100%;
      background: #0F172A;
      font-family: 'DM Sans', system-ui, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #1E293B;
      border: 1.5px solid #334155;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .logo {
      font-size: 22px;
      font-weight: 900;
      color: #F1F5F9;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }
    .sub {
      font-size: 13px;
      color: #64748B;
      margin-bottom: 32px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: #94A3B8;
      margin-bottom: 8px;
    }
    input[type=password] {
      width: 100%;
      background: #0F172A;
      border: 1.5px solid #334155;
      border-radius: 10px;
      padding: 13px 16px;
      font-size: 16px;
      font-family: inherit;
      color: #F1F5F9;
      outline: none;
      transition: border-color 0.15s;
      letter-spacing: 4px;
    }
    input[type=password]:focus { border-color: #3B82F6; }
    input[type=password]::placeholder { letter-spacing: 0; color: #475569; }
    button {
      width: 100%;
      margin-top: 16px;
      background: #3B82F6;
      color: #fff;
      border: none;
      border-radius: 10px;
      padding: 13px;
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    button:hover { background: #2563EB; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error {
      margin-top: 12px;
      background: #450A0A;
      border: 1px solid #7F1D1D;
      border-radius: 8px;
      padding: 10px 14px;
      color: #FCA5A5;
      font-size: 13px;
      display: none;
    }
    .error.show { display: block; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📊 Market Watch</div>
    <div class="sub">Enter your password to access the dashboard</div>
    <label for="pw">Password</label>
    <input type="password" id="pw" placeholder="Enter password" autocomplete="current-password" />
    <button id="btn" onclick="login()">Enter Dashboard</button>
    <div class="error" id="err">Incorrect password. Try again.</div>
  </div>
  <script>
    document.getElementById('pw').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') login();
    });
    async function login() {
      const pw = document.getElementById('pw').value;
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      if (!pw) return;
      btn.disabled = true;
      btn.textContent = 'Checking...';
      err.classList.remove('show');
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw }),
        });
        if (res.ok) {
          window.location.reload();
        } else {
          err.classList.add('show');
          btn.disabled = false;
          btn.textContent = 'Enter Dashboard';
          document.getElementById('pw').value = '';
          document.getElementById('pw').focus();
        }
      } catch(e) {
        err.textContent = 'Connection error. Try again.';
        err.classList.add('show');
        btn.disabled = false;
        btn.textContent = 'Enter Dashboard';
      }
    }
  </script>
</body>
</html>`;

  return new Response(loginHTML, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}
