const path = require("node:path");

module.exports = {
  apps: [{
    name: "fantasy-2026-preview",
    cwd: path.join(__dirname, "apps/web"),
    script: "node_modules/next/dist/bin/next",
    args: ["start", "--hostname", "127.0.0.1", "--port", "40435"],
    env: {
      NODE_ENV: "production",
      FANTASY_NEXT_DIST_DIR: ".next-analyst",
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      ESPN_SEASON: "2026",
      DATA_ROOT: path.join(__dirname, "data"),
      FANTASY_REPO_ROOT: __dirname,
      FANTASY_PYTHON: path.join(__dirname, ".venv/bin/python"),
    },
    time: true,
    max_restarts: 5,
    min_uptime: "10s",
  }],
};
