export async function toggleMarketTrading(marketId: string): Promise<void> {
  const res = await fetch(`/api/trading/${marketId}/toggle`, { method: "POST" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? "Failed to toggle trading");
  }
}

export async function setMarketMode(
  marketId: string,
  mode: "live" | "shadow",
): Promise<void> {
  const res = await fetch(`/api/mode/${marketId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? "Failed to switch mode");
  }
}

export async function resetMarketKillSwitches(marketId: string): Promise<void> {
  const res = await fetch(`/api/killswitches/${marketId}/reset`, { method: "POST" });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload.error ?? "Failed to reset kill switches");
  }
}
