import { login } from "./actions";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { error } = await searchParams;

  return (
    <main
      style={{
        maxWidth: 360,
        margin: "0 auto",
        padding: "96px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Document Reader</h1>

      <form action={login} style={{ display: "flex", gap: 10 }}>
        <input
          type="password"
          name="password"
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          required
          style={{
            flex: 1,
            minWidth: 0,
            background: "#111",
            color: "#e5e5e5",
            border: "1px solid #333",
            borderRadius: 4,
            padding: "6px 10px",
            font: "inherit",
          }}
        />
        <button
          type="submit"
          style={{
            background: "#1f1f1f",
            color: "#e5e5e5",
            border: "1px solid #333",
            borderRadius: 4,
            padding: "6px 14px",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          Log in
        </button>
      </form>

      {error && <div style={{ color: "#f87171" }}>Wrong password.</div>}
    </main>
  );
}
