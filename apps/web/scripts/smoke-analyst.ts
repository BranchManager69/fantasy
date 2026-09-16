import OpenAI from "openai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataRoot } from "../src/lib/paths";
import { AnalystBudget } from "../src/server/analyst-budget";
import { createAnalystContext } from "../src/server/analyst-context";
import { runAnalyst } from "../src/server/analyst-runner";

async function main() {
  const directory = path.join(getDataRoot(), "history", "analyst");
  const context = await createAnalystContext(2026, 1, 8);
  const result = await runAnalyst({
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 20_000 }),
    budget: new AnalystBudget({ directory }), context,
    season: 2026, week: 1, teamId: 8,
    question: "What actually decided Mr. Beastsaw's Week 1 matchup? Tell me the key NFL moment and whether my best single bench swap would have changed the result. Make it feel like football, and check the arithmetic.",
  });
  await fs.writeFile(path.join(directory, "runs", `${result.runId}-answer.json`), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => { console.error(error.name, error.code ?? "", error.message); process.exitCode = 1; });
