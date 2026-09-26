"use client";

import { useState } from "react";

const SOMETHING_WRONG = "Something went wrong, try again.";

function errorFor(status: number): string {
  if (status === 401) return "Wrong password.";
  if (status === 429) return "Too many attempts. Try again in 15 minutes.";
  return SOMETHING_WRONG;
}

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      if (res.ok) {
        window.location.href = "/admin";
        return;
      }
      setError(errorFor(res.status));
    } catch {
      setError(SOMETHING_WRONG);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0f0f0f] text-white">
      {/* method="post": if the script has not loaded, a native submit must never put the password in the URL. */}
      <form onSubmit={submit} method="post" className="w-80 space-y-4 rounded-xl border border-white/10 bg-[#141414] p-6">
        <h1 className="text-lg font-semibold">Arham Helpline Admin</h1>
        <label htmlFor="admin-password" className="sr-only">
          Password
        </label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          className="w-full rounded-md border border-white/10 bg-[#0f0f0f] px-3 py-2 text-sm focus:border-emerald-500/50 focus:outline-none"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button disabled={busy || !password} className="w-full rounded-md bg-emerald-500 py-2 text-sm font-medium text-black disabled:opacity-40">
          {busy ? "…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
