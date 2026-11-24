const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'web/assets/icons');
const svg = fs.readFileSync(path.join(root, 'web/assets/icon.svg'), 'utf8');
(async () => {
  fs.mkdirSync(directory, {recursive:true});
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({deviceScaleFactor:1});
    for(const [name,size,scale] of [['apple-touch-icon.png',180,100],['icon-192.png',192,100],['icon-512.png',512,100],['maskable-512.png',512,75]]){
      await page.setViewportSize({width:size,height:size});
      await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#121212}body{display:grid;place-items:center}svg{width:${scale}%;height:${scale}%}</style>${svg}`);
      await page.screenshot({path:path.join(directory,name),omitBackground:false});
      console.log('Exported',name,size+'x'+size);
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
