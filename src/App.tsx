import { useAuth } from "./features/auth/AuthProvider";
import { LoginCounter } from "./features/auth/LoginCounter";
import { Desk } from "./components/desk/Desk";

export default function App() {
  const { session, loading } = useAuth();

  if (loading) {
    return <div className="center-wait">Opening the bureau…</div>;
  }
  return session ? <Desk /> : <LoginCounter />;
}
