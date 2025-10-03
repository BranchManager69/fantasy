#!/usr/bin/env node

const http = require('http');

http.get('http://localhost:40435/api/sim/rest-of-season?season=2025', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const sim = JSON.parse(data);

    const teamMap = new Map();
    sim.teams.forEach(t => teamMap.set(t.team_id, t.name));

    const rankings = Object.entries(sim.team_schedule)
      .map(([teamId, schedule]) => {
        const futureWeeks = schedule.filter(s => s.week >= 5);
        const total = futureWeeks.reduce((sum, s) => sum + s.projected_points, 0);
        const avg = futureWeeks.length > 0 ? total / futureWeeks.length : 0;
        return {
          teamId: parseInt(teamId, 10),
          name: teamMap.get(parseInt(teamId, 10)),
          avg,
        };
      })
      .sort((a, b) => b.avg - a.avg);

    rankings.forEach((r, i) => {
      console.log(`${i + 1}. ${r.name}: ${r.avg.toFixed(2)} PPG`);
    });
  });
});
