import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', m => { if (m.type()==='error') console.log('[err]', m.text().slice(0,160)); });
await page.goto('http://127.0.0.1:3000/?debug&quality=high', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 15000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', { timeout: 30000 });
await page.waitForTimeout(3000);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
await page.evaluate(() => { const e=document.createElement('style'); e.textContent='#hud{opacity:0!important}'; document.head.appendChild(e); });
// Wait longer to let the volcano erupt / any timed fx kick in
await page.waitForTimeout(9000);
// Fly to a patch of open ocean far from the central volcano (0,0) and from islands.
await page.evaluate(() => {
  const g = window.__piratesBR;
  g.enableFreeCam(1100, 40, 1100, Math.atan2(-1,-1), -0.5);
});
await page.waitForTimeout(1200);
await page.screenshot({ path: 'test-results/audit-noon/_probe-openwater.png' });
// Traverse the scene for reddish objects near water and report.
const report = await page.evaluate(() => {
  const g = window.__piratesBR;
  // find the THREE scene
  let scene = g.scene || g.renderer?.scene || null;
  if (!scene) {
    // dig for a THREE.Scene on the game object
    for (const k of Object.keys(g)) { const v = g[k]; if (v && v.isScene) { scene = v; break; } }
  }
  if (!scene) return { error: 'no scene found', keys: Object.keys(g).slice(0,60) };
  const out = [];
  const tmp = { x:0,y:0,z:0 };
  scene.traverse((o) => {
    if (!o.visible) return;
    const mat = o.material;
    const mats = Array.isArray(mat) ? mat : (mat ? [mat] : []);
    for (const m of mats) {
      const c = m.color; const e = m.emissive;
      const red = (col) => col && col.r > 0.55 && col.r > col.g*1.4 && col.r > col.b*1.4;
      if (red(c) || red(e)) {
        o.updateWorldMatrix?.(true, false);
        const el = o.matrixWorld?.elements || [];
        tmp.x = el[12]||0; tmp.y = el[13]||0; tmp.z = el[14]||0;
        let count = 1;
        if (o.isPoints && o.geometry?.attributes?.position) count = o.geometry.attributes.position.count;
        out.push({
          type: o.type,
          name: o.name || '(unnamed)',
          isPoints: !!o.isPoints,
          count,
          color: c ? [+c.r.toFixed(2),+c.g.toFixed(2),+c.b.toFixed(2)] : null,
          emissive: e ? [+e.r.toFixed(2),+e.g.toFixed(2),+e.b.toFixed(2)] : null,
          wp: [Math.round(tmp.x), Math.round(tmp.y), Math.round(tmp.z)],
          matName: m.name || m.type,
          blending: m.blending,
        });
      }
    }
  });
  // dedupe by (type,matName,color) counting
  const agg = {};
  for (const r of out) {
    const key = `${r.type}|${r.matName}|${r.color}|${r.emissive}|pts${r.isPoints}`;
    if (!agg[key]) agg[key] = { ...r, instances: 0, totalPoints: 0, sampleWp: r.wp };
    agg[key].instances++;
    agg[key].totalPoints += r.count;
  }
  return { total: out.length, groups: Object.values(agg).slice(0, 40) };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
