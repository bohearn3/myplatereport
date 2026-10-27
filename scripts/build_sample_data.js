const E=require('../public/js/engine.js'); const fs=require('fs');
const D=JSON.parse(fs.readFileSync('data/games.json'));
const league={};
for (const zid of Object.keys(E.ZONES)){
  const Z=E.ZONES[zid]; const pts=[];
  for (const g of D.games){ const A=E.analyzeGame(g,D.fields,Z); if(A.summary.decisions<40) continue; pts.push(E.trendPoint(A,Z)); }
  const keys=['adj','raw','missN','edgeAcc','inZoneAcc','outZoneAcc','zoneSize','balance'];
  const avg={}; for(const k of keys){const v=pts.map(p=>p[k]).filter(x=>x!=null); avg[k]=v.reduce((a,b)=>a+b,0)/v.length;}
  avg.games=pts.length; league[zid]=avg;
  const s=[...pts].sort((a,b)=>a.adj-b.adj); 
  console.log(zid, JSON.stringify(avg), 'adj min/max', s[0].adj.toFixed(3), s[s.length-1].adj.toFixed(3));
}
const mine=D.games.filter(g=>g.umpire==="Brooks O'Hearn").sort((a,b)=>a.Date.localeCompare(b.Date));
const payload={fields:D.fields,league,currentFile:"WCC Trackman Analysis 3-22-26 O'Hearn.xlsm",games:mine.map(g=>({...g,file:g.file}))};
fs.writeFileSync('data.js','window.REPORT_DATA='+JSON.stringify(payload)+';');
console.log('data.js',fs.statSync('data.js').size, mine.map(g=>g.Date+' '+g.AwayTeam+'@'+g.HomeTeam));
