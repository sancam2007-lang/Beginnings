import { useState } from "react";
import { useAuth } from "./AuthProvider";

export function LoginCounter() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setNotice(null);
    if (!email.trim() || !password) {
      setError("Present your credentials to the clerk.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "signin") {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, fullName.trim());
        setNotice(
          "Registration received. If email confirmation is on, check your inbox, then present your credentials.",
        );
        setMode("signin");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "The clerk could not verify that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="counter">
      <div className="counter__card">
        <div className="counter__crest">
          <div className="ring">§</div>
        </div>
        <h2>Beginnings</h2>
        <div className="tagline">National Service Counter</div>

        {mode === "register" ? (
          <div className="field">
            <label htmlFor="name">Full legal name</label>
            <input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="email">Registered email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Pass phrase</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>

        {error ? <p className="note note--error">{error}</p> : null}
        {notice ? <p className="note">{notice}</p> : null}

        <div className="btn-row">
          <button className="btn btn--stamp" onClick={submit} disabled={busy} style={{ flex: 1 }}>
            {busy ? "Verifying…" : mode === "signin" ? "Present credentials" : "Register at the counter"}
          </button>
        </div>

        <p style={{ textAlign: "center", marginTop: 16 }}>
          {mode === "signin" ? (
            <button className="linkish" onClick={() => setMode("register")}>
              No record on file? Register
            </button>
          ) : (
            <button className="linkish" onClick={() => setMode("signin")}>
              Already registered? Present credentials
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
