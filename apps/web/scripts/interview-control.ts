/** Local operator CLI. It cannot accept or select a phone number. */
export {};
async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  const token = process.env.FANTASY_INTERVIEW_CONTROL_TOKEN;
  if (!token) throw new Error("FANTASY_INTERVIEW_CONTROL_TOKEN is required");
  if (!["status", "prepare", "dial", "end", "reconcile", "preflight"].includes(command)) throw new Error("Use status, prepare, dial, end, reconcile, or preflight");
  const payload = command === "prepare"
    ? { season: Number(args[0]), week: Number(args[1]), teamId: Number(args[2]), requestId: args[3] }
    : { id: args[0] };
  const response = await fetch(`http://127.0.0.1:${process.env.FANTASY_INTERVIEW_PORT || 40438}/internal/${command}`, {
    method: command === "status" ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: command === "status" ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(35_000),
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (!response.ok) process.exitCode = 1;
}
void main().catch((error) => { console.error(error.message); process.exitCode = 1; });
